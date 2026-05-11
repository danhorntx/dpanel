import { create } from 'zustand'
import { db } from '@/db/db'
import { generateId } from '@/lib/utils'
import type { Snippet } from '@/types/email'

interface SnippetsStore {
  snippets:  Snippet[]
  isLoading: boolean
  loaded:    boolean

  load:   () => Promise<void>
  create: (input: Pick<Snippet, 'shortcut' | 'name' | 'body'>) => Promise<Snippet>
  update: (id: string, patch: Partial<Pick<Snippet, 'shortcut' | 'name' | 'body'>>) => Promise<void>
  remove: (id: string) => Promise<void>
}

const SEED: Pick<Snippet, 'shortcut' | 'name' | 'body'>[] = [
  {
    shortcut: 'sig',
    name:     'Default signature',
    body:     '<br/><br/>—<br/>Sent from Duperhuman',
  },
  {
    shortcut: 'thanks',
    name:     'Thanks',
    body:     'Thanks so much, really appreciate it.',
  },
  {
    shortcut: 'lgtm',
    name:     'Looks good to me',
    body:     'Looks good to me — go ahead and ship it.',
  },
  {
    shortcut: 'meet',
    name:     'Schedule a meeting',
    body:     'Happy to find time — what does your week look like? I can do most afternoons CT.',
  },
]

export const useSnippetsStore = create<SnippetsStore>((set, get) => ({
  snippets:  [],
  isLoading: false,
  loaded:    false,

  load: async () => {
    if (get().loaded) return
    set({ isLoading: true })
    let snippets = await db.snippets.orderBy('updatedAt').reverse().toArray()
    // Seed once on first run so the user has examples to learn from
    if (snippets.length === 0) {
      const now = Date.now()
      const created: Snippet[] = SEED.map(s => ({
        ...s,
        id:        generateId(),
        createdAt: now,
        updatedAt: now,
      }))
      await db.snippets.bulkPut(created)
      snippets = created
    }
    set({ snippets, isLoading: false, loaded: true })
  },

  create: async ({ shortcut, name, body }) => {
    const now = Date.now()
    const snippet: Snippet = {
      id:        generateId(),
      shortcut:  shortcut.trim(),
      name:      name.trim() || 'Untitled',
      body,
      createdAt: now,
      updatedAt: now,
    }
    await db.snippets.put(snippet)
    set(s => ({ snippets: [snippet, ...s.snippets] }))
    return snippet
  },

  update: async (id, patch) => {
    const updatedAt = Date.now()
    await db.snippets.update(id, { ...patch, updatedAt })
    set(s => ({
      snippets: s.snippets.map(sn => sn.id === id ? { ...sn, ...patch, updatedAt } : sn),
    }))
  },

  remove: async (id) => {
    await db.snippets.delete(id)
    set(s => ({ snippets: s.snippets.filter(sn => sn.id !== id) }))
  },
}))

/** Filter snippets by typed query (matches shortcut OR name, prefix-first). */
export function filterSnippets(snippets: Snippet[], query: string, limit = 8): Snippet[] {
  if (!query) return snippets.slice(0, limit)
  const q = query.toLowerCase()
  const scored = snippets
    .map(s => {
      const sc = s.shortcut.toLowerCase()
      const nm = s.name.toLowerCase()
      let score = 0
      if (sc === q)            score = 100
      else if (sc.startsWith(q)) score = 80
      else if (nm.startsWith(q)) score = 60
      else if (sc.includes(q))   score = 40
      else if (nm.includes(q))   score = 20
      return { s, score }
    })
    .filter(x => x.score > 0)
    .sort((a, b) => b.score - a.score)
    .map(x => x.s)
  return scored.slice(0, limit)
}
