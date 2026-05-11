import type { FastifyInstance } from 'fastify'
import { getAccount, getCachedEmails, syncFolder } from '../services/sync.js'

export async function searchRoutes(app: FastifyInstance) {
  app.get<{
    Querystring: { q: string; accountId: string; limit?: string }
  }>('/search', async (req, reply) => {
    const { q, accountId, limit = '20' } = req.query
    if (!q || !accountId) return reply.status(400).send({ error: 'q and accountId required' })

    const account = getAccount(accountId)
    if (!account) return reply.status(404).send({ error: 'Account not found' })

    // Ensure we have a warm cache
    await syncFolder(accountId, 'INBOX', 200, 0).catch(() => {})

    const all = getCachedEmails(accountId, 'INBOX')
    const query = q.toLowerCase()
    const lim = parseInt(limit, 10)

    const results = all
      .filter(e =>
        e.subject.toLowerCase().includes(query) ||
        e.from.name.toLowerCase().includes(query) ||
        e.from.address.toLowerCase().includes(query) ||
        e.snippet.toLowerCase().includes(query) ||
        e.bodyText.toLowerCase().includes(query)
      )
      .slice(0, lim)

    return results
  })

  // Sync trigger
  app.post<{
    Body: { accountId: string; folder?: string }
  }>('/sync', async (req, reply) => {
    const { accountId, folder = 'INBOX' } = req.body
    const account = getAccount(accountId)
    if (!account) return reply.status(404).send({ error: 'Account not found' })

    // Non-blocking: start sync and return immediately
    syncFolder(accountId, folder, 100, 0, true).catch(err =>
      console.error('Sync error:', err)
    )

    return { status: 'syncing' }
  })

  // Sync status
  app.get<{
    Querystring: { accountId: string }
  }>('/sync/status', async (req, reply) => {
    const { accountId } = req.query
    const account = getAccount(accountId)
    if (!account) return reply.status(404).send({ error: 'Not found' })
    return {
      status: 'idle',
      progress: 100,
      lastSync: account.lastSync,
    }
  })
}
