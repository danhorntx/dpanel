import { db } from '@/db/db'
import type { Email, FollowUpReminder } from '@/types/email'

export async function resurfaceDueSnoozes(accountId: string): Promise<Email[]> {
  const due = await db.emails
    .where('accountId')
    .equals(accountId)
    .filter(e => !!e.snoozedUntil && e.snoozedUntil <= Date.now())
    .toArray()

  if (due.length === 0) return []

  await db.emails.bulkPut(due.map(e => ({
    ...e,
    snoozedUntil: undefined,
    isArchived: false,
    folder: e.folder || 'INBOX',
  })))

  return due.map(e => ({ ...e, snoozedUntil: undefined, isArchived: false }))
}

export async function createFollowUp(email: Email, dueAt: number, note?: string): Promise<FollowUpReminder> {
  const reminder: FollowUpReminder = {
    id: `fu_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
    emailId: email.id,
    accountId: email.accountId,
    dueAt,
    note,
    createdAt: Date.now(),
  }
  await db.followUps.put(reminder)
  return reminder
}

export async function dueFollowUps(accountId: string): Promise<FollowUpReminder[]> {
  return db.followUps
    .where('accountId')
    .equals(accountId)
    .filter(f => !f.completedAt && f.dueAt <= Date.now())
    .toArray()
}

export async function completeFollowUp(id: string) {
  await db.followUps.update(id, { completedAt: Date.now() })
}

