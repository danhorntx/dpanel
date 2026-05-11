import { db } from '@/db/db'
import { emails as emailsApi } from '@/lib/api'
import type { OutboxEmail, SendEmailPayload } from '@/types/email'

export async function queueEmail(payload: SendEmailPayload, sendAt = Date.now()): Promise<OutboxEmail> {
  const now = Date.now()
  const item: OutboxEmail = {
    id: `out_${now}_${Math.random().toString(36).slice(2, 8)}`,
    accountId: payload.accountId,
    to: payload.to,
    cc: payload.cc ?? [],
    bcc: payload.bcc ?? [],
    subject: payload.subject,
    bodyHtml: payload.bodyHtml,
    bodyText: payload.bodyText,
    replyToId: payload.replyToId,
    forwardOfId: payload.forwardOfId,
    draftSourceId: payload.draftSourceId,
    sendAt,
    createdAt: now,
    status: 'queued',
    attempts: 0,
  }
  await db.outbox.put(item)
  return item
}

export async function processOutbox(limit = 5): Promise<{ sent: number; failed: number }> {
  const due = await db.outbox
    .where('sendAt')
    .belowOrEqual(Date.now())
    .and(item => item.status !== 'sending')
    .limit(limit)
    .toArray()

  let sent = 0
  let failed = 0

  for (const item of due) {
    await db.outbox.update(item.id, { status: 'sending', attempts: item.attempts + 1, lastError: undefined })
    try {
      await emailsApi.send({
        accountId: item.accountId,
        to: item.to,
        cc: item.cc,
        bcc: item.bcc,
        subject: item.subject,
        bodyHtml: item.bodyHtml,
        bodyText: item.bodyText,
        replyToId: item.replyToId,
        forwardOfId: item.forwardOfId,
        draftSourceId: item.draftSourceId,
      })
      await db.outbox.delete(item.id)
      sent += 1
    } catch (err) {
      failed += 1
      const msg = err instanceof Error ? err.message : String(err)
      const backoffMs = Math.min(30 * 60_000, 2 ** Math.min(item.attempts, 6) * 10_000)
      await db.outbox.update(item.id, {
        status: 'failed',
        lastError: msg,
        sendAt: Date.now() + backoffMs,
      })
    }
  }

  return { sent, failed }
}
