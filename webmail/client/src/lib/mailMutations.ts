import { db } from '@/db/db'
import { emails as emailsApi } from '@/lib/api'
import type { MailMutation, MailMutationType } from '@/types/email'

interface QueueMutationInput {
  accountId: string
  type: MailMutationType
  ids: string[]
  payload?: MailMutation['payload']
}

function mutationKey(input: QueueMutationInput): string {
  const ids = [...input.ids].sort().join(',')
  const payload = JSON.stringify(input.payload ?? {})
  return `${input.accountId}:${input.type}:${ids}:${payload}`
}

export async function queueMailMutation(input: QueueMutationInput): Promise<MailMutation> {
  const now = Date.now()
  const id = mutationKey(input)
  const existing = await db.mailMutations.get(id)
  const mutation: MailMutation = {
    id,
    accountId: input.accountId,
    type: input.type,
    ids: input.ids,
    payload: input.payload,
    createdAt: existing?.createdAt ?? now,
    updatedAt: now,
    attempts: existing?.attempts ?? 0,
    status: 'queued',
    lastError: undefined,
  }
  await db.mailMutations.put(mutation)
  return mutation
}

export async function cancelMailMutations(ids: string[], types?: MailMutationType[]) {
  const idSet = new Set(ids)
  const typeSet = types ? new Set(types) : null
  const rows = await db.mailMutations.toArray()
  const toDelete = rows
    .filter(row => (!typeSet || typeSet.has(row.type)) && row.ids.some(id => idSet.has(id)))
    .map(row => row.id)
  if (toDelete.length > 0) await db.mailMutations.bulkDelete(toDelete)
}

export async function processMailMutations(limit = 10): Promise<{ processed: number; failed: number }> {
  const due = await db.mailMutations
    .where('status')
    .anyOf('queued', 'failed')
    .limit(limit)
    .toArray()

  let processed = 0
  let failed = 0

  for (const mutation of due) {
    await db.mailMutations.update(mutation.id, {
      status: 'sending',
      attempts: mutation.attempts + 1,
      updatedAt: Date.now(),
      lastError: undefined,
    })

    try {
      await runMutation(mutation)
      await db.mailMutations.delete(mutation.id)
      processed += 1
    } catch (err) {
      failed += 1
      const message = err instanceof Error ? err.message : String(err)
      await db.mailMutations.update(mutation.id, {
        status: 'failed',
        updatedAt: Date.now(),
        lastError: message,
      })
    }
  }

  return { processed, failed }
}

async function runMutation(mutation: MailMutation) {
  switch (mutation.type) {
    case 'archive':
      await emailsApi.archive(mutation.ids)
      return
    case 'trash':
      await emailsApi.trash(mutation.ids)
      return
    case 'restore':
      await emailsApi.restore(mutation.ids)
      return
    case 'markRead':
      await emailsApi.markRead(mutation.ids, mutation.payload?.read ?? true)
      return
    case 'star':
      await emailsApi.star(mutation.ids, mutation.payload?.starred ?? true)
      return
    case 'spam':
      await emailsApi.spam(mutation.ids)
      return
    case 'snooze':
      await emailsApi.snooze(mutation.ids, mutation.payload?.until ?? Date.now())
      return
    case 'mute':
      if (mutation.payload?.threadId) await emailsApi.mute(mutation.payload.threadId)
      return
    case 'label':
      await emailsApi.label(mutation.ids, mutation.payload?.labels ?? [])
      return
  }
}
