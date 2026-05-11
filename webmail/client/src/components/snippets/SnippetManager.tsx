import { useEffect, useState } from 'react'
import { PlusIcon, TrashIcon, LightningIcon, CheckIcon } from '@phosphor-icons/react'
import { useSnippetsStore } from '@/store/snippetsStore'
import { useUiStore } from '@/store/uiStore'
import type { Snippet } from '@/types/email'

export function SnippetManager() {
  const snippets = useSnippetsStore(s => s.snippets)
  const load     = useSnippetsStore(s => s.load)
  const create   = useSnippetsStore(s => s.create)
  const update   = useSnippetsStore(s => s.update)
  const remove   = useSnippetsStore(s => s.remove)
  const toast    = useUiStore(s => s.toast)

  const [editingId, setEditingId] = useState<string | null>(null)

  useEffect(() => { load() }, [load])

  const editing = snippets.find(s => s.id === editingId) ?? null

  const handleNew = async () => {
    const sn = await create({ shortcut: 'new', name: 'New snippet', body: '' })
    setEditingId(sn.id)
  }

  const handleDelete = async (id: string) => {
    if (!confirm('Delete this snippet?')) return
    await remove(id)
    if (editingId === id) setEditingId(null)
    toast('Snippet deleted')
  }

  return (
    <div className="max-w-3xl mx-auto px-8 py-8">
      <div className="flex items-center justify-between mb-6">
        <div>
          <h2 className="text-2xl font-semibold text-[var(--text-primary)]" style={{ letterSpacing: '-0.02em' }}>
            Snippets
          </h2>
          <p className="text-xs text-[var(--text-muted)] mt-1">
            Type <kbd>;</kbd> in compose to insert one inline.
          </p>
        </div>
        <button
          onClick={handleNew}
          className="flex items-center gap-1.5 px-3 py-2 rounded-lg text-sm font-medium transition-all"
          style={{ background: 'var(--accent-faint)', border: '1px solid var(--border-accent)', color: 'var(--accent)' }}
        >
          <PlusIcon size={13} weight="bold" />
          New snippet
        </button>
      </div>

      {snippets.length === 0 ? (
        <div className="rounded-lg p-12 text-center" style={{ background: 'var(--bg-overlay)', border: '1px solid var(--border-subtle)' }}>
          <LightningIcon size={28} style={{ color: 'var(--text-disabled)', margin: '0 auto 12px' }} />
          <p className="text-sm text-[var(--text-secondary)]">No snippets yet</p>
        </div>
      ) : (
        <div className="space-y-2">
          {snippets.map(s => (
            <SnippetRow
              key={s.id}
              snippet={s}
              editing={editingId === s.id}
              onOpen={() => setEditingId(editingId === s.id ? null : s.id)}
              onSave={async patch => {
                await update(s.id, patch)
                toast('Snippet saved')
              }}
              onDelete={() => handleDelete(s.id)}
            />
          ))}
        </div>
      )}
    </div>
  )
}

function SnippetRow({ snippet, editing, onOpen, onSave, onDelete }: {
  snippet: Snippet
  editing: boolean
  onOpen:  () => void
  onSave:  (patch: Pick<Snippet, 'shortcut' | 'name' | 'body'>) => Promise<void>
  onDelete: () => void
}) {
  const [shortcut, setShortcut] = useState(snippet.shortcut)
  const [name,     setName]     = useState(snippet.name)
  const [body,     setBody]     = useState(snippet.body)

  useEffect(() => {
    setShortcut(snippet.shortcut)
    setName(snippet.name)
    setBody(snippet.body)
  }, [snippet])

  const dirty = shortcut !== snippet.shortcut || name !== snippet.name || body !== snippet.body

  return (
    <div
      className="rounded-lg overflow-hidden"
      style={{ background: 'var(--bg-overlay)', border: '1px solid var(--border-subtle)' }}
    >
      <button
        onClick={onOpen}
        className="w-full flex items-center gap-3 px-4 py-3 text-left transition-colors hover:bg-[var(--bg-hover)]"
      >
        <span
          className="text-[10px] font-mono font-semibold flex-shrink-0 px-1.5 py-0.5 rounded"
          style={{
            background: 'var(--accent-faint)',
            color:      'var(--accent)',
            border:     '1px solid var(--border-accent)',
          }}
        >
          ;{snippet.shortcut}
        </span>
        <div className="flex-1 min-w-0">
          <div className="text-sm text-[var(--text-primary)] truncate">{snippet.name}</div>
          <div className="text-xs text-[var(--text-muted)] truncate">
            {snippet.body.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 100)}
          </div>
        </div>
      </button>

      {editing && (
        <div className="px-4 py-3 border-t" style={{ borderColor: 'var(--border-subtle)' }}>
          <div className="grid grid-cols-[120px_1fr] gap-2 mb-2">
            <FieldInput label="Shortcut" value={shortcut} onChange={setShortcut} placeholder="e.g. sig" mono />
            <FieldInput label="Name"     value={name}     onChange={setName}     placeholder="Default signature" />
          </div>
          <div className="mb-2">
            <label className="text-[11px] uppercase tracking-wider text-[var(--text-muted)] block mb-1">Body (HTML supported)</label>
            <textarea
              value={body}
              onChange={e => setBody(e.target.value)}
              rows={6}
              placeholder="The text to insert at the cursor…"
              className="w-full px-3 py-2 rounded-md text-sm bg-[var(--bg-base)] text-[var(--text-primary)] outline-none font-mono"
              style={{ border: '1px solid var(--border-subtle)' }}
            />
          </div>
          <div className="flex justify-end gap-2">
            <button
              onClick={onDelete}
              className="flex items-center gap-1.5 px-3 py-1.5 rounded-md text-xs transition-colors hover:bg-[var(--bg-hover)]"
              style={{ color: 'var(--text-muted)' }}
            >
              <TrashIcon size={11} /> Delete
            </button>
            <button
              onClick={() => onSave({ shortcut, name, body })}
              disabled={!dirty}
              className="flex items-center gap-1.5 px-3 py-1.5 rounded-md text-xs font-semibold disabled:opacity-40"
              style={{ background: 'var(--accent)', color: 'var(--accent-contrast)' }}
            >
              <CheckIcon size={11} weight="bold" /> Save
            </button>
          </div>
        </div>
      )}
    </div>
  )
}

function FieldInput({ label, value, onChange, placeholder, mono }: {
  label: string
  value: string
  onChange: (v: string) => void
  placeholder?: string
  mono?: boolean
}) {
  return (
    <div>
      <label className="text-[11px] uppercase tracking-wider text-[var(--text-muted)] block mb-1">{label}</label>
      <input
        type="text"
        value={value}
        onChange={e => onChange(e.target.value)}
        placeholder={placeholder}
        className={`w-full px-3 py-2 rounded-md text-sm bg-[var(--bg-base)] text-[var(--text-primary)] outline-none ${mono ? 'font-mono' : ''}`}
        style={{ border: '1px solid var(--border-subtle)' }}
      />
    </div>
  )
}
