import { useEffect, useState } from 'react'
import {
  ArrowLeftIcon, PlusIcon, TrashIcon, TagIcon, CheckIcon, GearSixIcon, LightningIcon,
} from '@phosphor-icons/react'
import { useUiStore } from '@/store/uiStore'
import { useEmailStore } from '@/store/emailStore'
import { useLabelsStore, defaultLabelInput, emptyRule } from '@/store/labelsStore'
import { SnippetManager } from '@/components/snippets/SnippetManager'
import { generateId } from '@/lib/utils'
import type { CustomLabel, LabelRule, RuleField, RuleOperator, RuleConjunction } from '@/types/email'

const LABEL_COLORS = ['#8fb3ff', '#64b5a1', '#e0b45d', '#d77b8a', '#8ba3b8', '#a6b36b', '#c08a5a', '#7cb7d8']

export function LabelManager() {
  const back            = useUiStore(s => s.openMailView)
  const managingId      = useUiStore(s => s.managingLabelId)
  const setManagingId   = useUiStore(s => s.openLabelManager)
  const account         = useEmailStore(s => s.getActiveAccount())
  const labels          = useLabelsStore(s => s.labels)
  const load            = useLabelsStore(s => s.load)
  const create          = useLabelsStore(s => s.create)
  const remove          = useLabelsStore(s => s.remove)
  const toast           = useUiStore(s => s.toast)

  // 'settings' / 'snippets' are virtual selections — not labels. We use
  // sentinel ids to represent them in `managingId`.
  const SETTINGS_ID     = '__settings__'
  const SNIPPETS_ID     = '__snippets__'
  const showSettings    = managingId === SETTINGS_ID
  const showSnippets    = managingId === SNIPPETS_ID

  useEffect(() => { load() }, [load])

  const editing = labels.find(l => l.id === managingId) ?? null

  const handleNew = async () => {
    if (!account) return
    const label = await create(defaultLabelInput(account.id))
    setManagingId(label.id)
  }

  const handleDelete = async (id: string) => {
    if (!confirm('Delete this label? Emails will keep their data, just lose this tag.')) return
    await remove(id)
    if (managingId === id) setManagingId(null)
    toast('Label deleted')
  }

  return (
    <div className="flex h-full overflow-hidden">
      {/* List of labels */}
      <div
        className="w-72 flex-shrink-0 border-r flex flex-col"
        style={{ borderColor: 'var(--border-subtle)', background: 'var(--bg-elevated)' }}
      >
        <div className="px-4 py-4 border-b" style={{ borderColor: 'var(--border-subtle)' }}>
          <div className="flex items-center gap-2 mb-3">
            <button
              onClick={back}
              className="p-1.5 rounded-md transition-colors hover:bg-[var(--bg-hover)]"
              style={{ color: 'var(--text-muted)' }}
              title="Back to mail (Esc)"
            >
              <ArrowLeftIcon size={14} />
            </button>
            <span className="text-sm font-semibold text-[var(--text-primary)]">Labels & Rules</span>
          </div>
          <button
            onClick={handleNew}
            className="w-full flex items-center justify-center gap-1.5 px-3 py-2 rounded-lg text-sm font-medium transition-all"
            style={{ background: 'var(--accent-faint)', border: '1px solid var(--border-accent)', color: 'var(--accent)' }}
          >
            <PlusIcon size={13} weight="bold" />
            New label
          </button>
        </div>

        {/* Settings shortcut */}
        <button
          onClick={() => setManagingId(SETTINGS_ID)}
          className="flex items-center gap-2 px-4 py-2.5 transition-colors"
          style={{
            background: showSettings ? 'var(--bg-active)' : 'transparent',
            color:      showSettings ? 'var(--text-primary)' : 'var(--text-secondary)',
          }}
        >
          <GearSixIcon size={14} weight="duotone" />
          <span className="text-sm">Settings</span>
        </button>

        {/* Snippets */}
        <button
          onClick={() => setManagingId(SNIPPETS_ID)}
          className="flex items-center gap-2 px-4 py-2.5 transition-colors"
          style={{
            background: showSnippets ? 'var(--bg-active)' : 'transparent',
            color:      showSnippets ? 'var(--text-primary)' : 'var(--text-secondary)',
            borderBottom: '1px solid var(--border-subtle)',
          }}
        >
          <LightningIcon size={14} weight="duotone" />
          <span className="text-sm">Snippets</span>
        </button>

        <div className="flex-1 overflow-y-auto py-2">
          {labels.length === 0 ? (
            <div className="px-4 py-12 text-center">
              <TagIcon size={28} style={{ color: 'var(--text-disabled)', margin: '0 auto 12px' }} />
              <p className="text-sm text-[var(--text-secondary)] mb-1">No labels yet</p>
              <p className="text-xs text-[var(--text-muted)]">Create one to auto-sort incoming mail.</p>
            </div>
          ) : (
            labels.map(l => (
              <div
                key={l.id}
                className="group flex items-center gap-2 px-3 py-2 cursor-pointer transition-colors"
                onClick={() => setManagingId(l.id)}
                style={{ background: managingId === l.id ? 'var(--bg-active)' : 'transparent' }}
              >
                <span className="w-3 h-3 rounded-sm flex-shrink-0" style={{ background: l.color }} />
                <span className="text-sm flex-1 truncate" style={{ color: 'var(--text-primary)' }}>{l.name}</span>
                <button
                  onClick={e => { e.stopPropagation(); handleDelete(l.id) }}
                  className="opacity-0 group-hover:opacity-100 p-1 rounded transition-all hover:bg-[var(--bg-overlay)]"
                  style={{ color: 'var(--text-muted)' }}
                  title="Delete label"
                >
                  <TrashIcon size={11} />
                </button>
              </div>
            ))
          )}
        </div>
      </div>

      {/* Editor pane */}
      <div className="flex-1 overflow-y-auto">
        {showSettings ? <SettingsPanel /> :
         showSnippets ? <SnippetManager /> :
         editing      ? <LabelEditor key={editing.id} label={editing} /> :
        (
          <div className="flex flex-col items-center justify-center h-full gap-3 px-8">
            <div className="w-14 h-14 rounded-xl flex items-center justify-center" style={{ background: 'var(--accent-faint)', border: '1px solid var(--border-accent)' }}>
              <TagIcon size={24} style={{ color: 'var(--accent)' }} />
            </div>
            <p className="text-sm font-medium text-[var(--text-secondary)]">Select a label to edit</p>
            <p className="text-xs text-[var(--text-muted)]">Or create a new one to start auto-sorting mail.</p>
          </div>
        )}
      </div>
    </div>
  )
}

function SettingsPanel() {
  const settings   = useUiStore(s => s.settings)
  const setSetting = useUiStore(s => s.setSetting)

  return (
    <div className="max-w-2xl mx-auto px-8 py-8">
      <h2
        className="text-2xl font-semibold mb-6 text-[var(--text-primary)]"
        style={{ letterSpacing: '-0.02em' }}
      >
        Settings
      </h2>

      <SettingGroup title="Composing">
        <SettingToggle
          label="Compose in full screen"
          description="Open the new-message editor in a full window instead of the corner panel."
          value={settings.composeFullScreen}
          onChange={v => setSetting('composeFullScreen', v)}
        />
        <SettingToggle
          label="Reply in full screen"
          description="Open Reply, Reply-All, and Forward in a full window."
          value={settings.replyFullScreen}
          onChange={v => setSetting('replyFullScreen', v)}
        />
      </SettingGroup>

      <SettingGroup title="Reading">
        <SettingToggle
          label="Automatically load images in HTML emails"
          description="Show remote images as soon as a message opens."
          value={settings.automaticallyLoadImages}
          onChange={v => setSetting('automaticallyLoadImages', v)}
        />
        <SettingChoice
          label="Default email preview theme"
          description="Choose the starting appearance for HTML email previews."
          value={settings.emailPreviewTheme}
          options={[
            { label: 'Light', value: 'light' },
            { label: 'Dark', value: 'dark' },
          ]}
          onChange={v => setSetting('emailPreviewTheme', v)}
        />
      </SettingGroup>
    </div>
  )
}

function SettingGroup({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="mb-8">
      <h3 className="text-label text-[var(--text-muted)] mb-3">{title}</h3>
      <div
        className="rounded-lg overflow-hidden"
        style={{ background: 'var(--bg-overlay)', border: '1px solid var(--border-subtle)' }}
      >
        {children}
      </div>
    </section>
  )
}

function SettingToggle({ label, description, value, onChange }: {
  label: string
  description: string
  value: boolean
  onChange: (v: boolean) => void
}) {
  return (
    <button
      onClick={() => onChange(!value)}
      className="w-full flex items-start justify-between gap-4 px-4 py-3 text-left transition-colors hover:bg-[var(--bg-hover)]"
      style={{ borderBottom: '1px solid var(--border-subtle)' }}
    >
      <div className="min-w-0">
        <div className="text-sm font-medium text-[var(--text-primary)]">{label}</div>
        <div className="text-xs text-[var(--text-muted)] mt-0.5">{description}</div>
      </div>
      <div
        className="relative flex-shrink-0 w-9 h-5 rounded-full transition-colors"
        style={{
          background: value ? 'var(--accent)' : 'var(--bg-hover)',
          border:     '1px solid var(--border-subtle)',
        }}
      >
        <span
          className="absolute top-0.5 w-3.5 h-3.5 rounded-full transition-all"
          style={{
            left: value ? 'calc(100% - 18px)' : '2px',
            background: value ? 'var(--accent-contrast)' : 'var(--text-muted)',
          }}
        />
      </div>
    </button>
  )
}

function SettingChoice<T extends string>({ label, description, value, options, onChange }: {
  label: string
  description: string
  value: T
  options: { label: string; value: T }[]
  onChange: (v: T) => void
}) {
  return (
    <div
      className="w-full flex items-start justify-between gap-4 px-4 py-3"
      style={{ borderBottom: '1px solid var(--border-subtle)' }}
    >
      <div className="min-w-0">
        <div className="text-sm font-medium text-[var(--text-primary)]">{label}</div>
        <div className="text-xs text-[var(--text-muted)] mt-0.5">{description}</div>
      </div>
      <div
        className="flex flex-shrink-0 rounded-lg p-0.5"
        style={{ background: 'var(--bg-hover)', border: '1px solid var(--border-subtle)' }}
      >
        {options.map(option => {
          const selected = option.value === value
          return (
            <button
              key={option.value}
              type="button"
              onClick={() => onChange(option.value)}
              className="px-2.5 py-1 rounded-md text-xs font-medium transition-colors"
              style={{
                background: selected ? 'var(--accent)' : 'transparent',
                color: selected ? 'var(--accent-contrast)' : 'var(--text-muted)',
              }}
            >
              {option.label}
            </button>
          )
        })}
      </div>
    </div>
  )
}

function LabelEditor({ label }: { label: CustomLabel }) {
  const update          = useLabelsStore(s => s.update)
  const applyRulesBulk  = useLabelsStore(s => s.applyRulesBulk)
  const reload          = useEmailStore(s => s.loadEmails)
  const toast           = useUiStore(s => s.toast)

  const [draft, setDraft] = useState<CustomLabel>(label)
  const [dirty, setDirty] = useState(false)
  const [running, setRunning] = useState(false)

  useEffect(() => { setDraft(label); setDirty(false) }, [label])

  const patch = (p: Partial<CustomLabel>) => {
    setDraft(d => ({ ...d, ...p }))
    setDirty(true)
  }

  const patchRule = (rid: string, p: Partial<LabelRule>) => {
    setDraft(d => ({ ...d, rules: d.rules.map(r => r.id === rid ? { ...r, ...p } : r) }))
    setDirty(true)
  }

  const removeRule = (rid: string) => {
    setDraft(d => ({ ...d, rules: d.rules.filter(r => r.id !== rid) }))
    setDirty(true)
  }

  const addRule = () => {
    setDraft(d => ({ ...d, rules: [...d.rules, { ...emptyRule(), id: generateId() }] }))
    setDirty(true)
  }

  const save = async () => {
    await update(label.id, {
      name: draft.name.trim() || 'Unnamed',
      color: draft.color,
      rules: draft.rules,
      conjunction: draft.conjunction,
    })
    setDirty(false)
    toast('Label saved')
  }

  const reapply = async () => {
    if (!confirm(`Re-run rules for "${draft.name}" against all existing emails?`)) return
    setRunning(true)
    const tagged = await applyRulesBulk(draft.id)
    setRunning(false)
    toast(`Tagged ${tagged} email${tagged === 1 ? '' : 's'}`)
    reload()
  }

  return (
    <div className="max-w-3xl mx-auto px-8 py-8">
      {/* Header */}
      <div className="flex items-center gap-3 mb-6">
        <input
          value={draft.name}
          onChange={e => patch({ name: e.target.value })}
          className="text-2xl font-semibold bg-transparent text-[var(--text-primary)] outline-none flex-1"
          style={{ letterSpacing: '-0.02em' }}
        />
        {dirty && (
          <button
            onClick={save}
            className="flex items-center gap-1.5 px-3 py-1.5 rounded-md text-sm font-medium"
            style={{ background: 'var(--accent)', color: 'var(--accent-contrast)' }}
          >
            <CheckIcon size={12} weight="bold" /> Save
          </button>
        )}
      </div>

      {/* Color picker */}
      <div className="mb-6">
        <div className="text-label text-[var(--text-muted)] mb-2">Color</div>
        <div className="flex items-center gap-2">
          {LABEL_COLORS.map(c => (
            <button
              key={c}
              onClick={() => patch({ color: c })}
              className="w-7 h-7 rounded-full transition-transform"
              style={{
                background: c,
                transform:  draft.color === c ? 'scale(1.15)' : 'scale(1)',
                boxShadow:  draft.color === c ? `0 0 0 2px var(--bg-base), 0 0 0 4px ${c}` : 'none',
              }}
            />
          ))}
        </div>
      </div>

      {/* Rule conjunction */}
      <div className="flex items-center justify-between mb-3">
        <div className="text-label text-[var(--text-muted)]">Rules</div>
        <div className="flex items-center gap-2 text-xs text-[var(--text-secondary)]">
          Match
          <select
            value={draft.conjunction}
            onChange={e => patch({ conjunction: e.target.value as RuleConjunction })}
            className="bg-[var(--bg-overlay)] border border-[var(--border-subtle)] rounded px-2 py-1 text-xs outline-none"
          >
            <option value="AND">all rules (AND)</option>
            <option value="OR">any rule (OR)</option>
          </select>
        </div>
      </div>

      <div className="space-y-2 mb-4">
        {draft.rules.map(r => (
          <RuleRow key={r.id} rule={r} onChange={p => patchRule(r.id, p)} onRemove={() => removeRule(r.id)} />
        ))}
        <button
          onClick={addRule}
          className="flex items-center gap-1.5 px-3 py-1.5 rounded-md text-xs transition-colors hover:bg-[var(--bg-hover)]"
          style={{ color: 'var(--text-muted)', border: '1px dashed var(--border-subtle)' }}
        >
          <PlusIcon size={11} weight="bold" /> Add rule
        </button>
      </div>

      {/* Bulk re-run */}
      <div className="border-t pt-6 mt-8" style={{ borderColor: 'var(--border-subtle)' }}>
        <div className="text-label text-[var(--text-muted)] mb-2">Apply to existing email</div>
        <p className="text-xs text-[var(--text-muted)] mb-3">
          Rules apply automatically to incoming mail. Use this to backfill against all email already in your local cache.
        </p>
        <button
          onClick={reapply}
          disabled={running || dirty}
          className="px-3 py-2 rounded-md text-sm transition-all disabled:opacity-40 disabled:cursor-not-allowed"
          style={{ background: 'var(--bg-hover)', border: '1px solid var(--border-subtle)', color: 'var(--text-secondary)' }}
        >
          {running ? 'Applying…' : dirty ? 'Save first' : 'Re-run rules now'}
        </button>
      </div>
    </div>
  )
}

const FIELD_LABELS: Record<RuleField, string> = {
  from:          'From',
  to:            'To',
  subject:       'Subject',
  body:          'Body',
  hasAttachment: 'Has attachment',
  domain:        'Sender domain',
}

function RuleRow({ rule, onChange, onRemove }: {
  rule: LabelRule
  onChange: (p: Partial<LabelRule>) => void
  onRemove: () => void
}) {
  const isBool = rule.field === 'hasAttachment'

  return (
    <div
      className="flex items-center gap-2 px-3 py-2 rounded-md"
      style={{ background: 'var(--bg-overlay)', border: '1px solid var(--border-subtle)' }}
    >
      <select
        value={rule.field}
        onChange={e => onChange({ field: e.target.value as RuleField, operator: e.target.value === 'hasAttachment' ? 'is' : 'contains' })}
        className="bg-transparent text-sm text-[var(--text-primary)] outline-none cursor-pointer"
      >
        {(Object.keys(FIELD_LABELS) as RuleField[]).map(f => (
          <option key={f} value={f}>{FIELD_LABELS[f]}</option>
        ))}
      </select>

      {!isBool && (
        <select
          value={rule.operator}
          onChange={e => onChange({ operator: e.target.value as RuleOperator })}
          className="bg-transparent text-sm text-[var(--text-secondary)] outline-none cursor-pointer"
        >
          <option value="contains">contains</option>
          <option value="equals">equals</option>
          <option value="startsWith">starts with</option>
          <option value="endsWith">ends with</option>
        </select>
      )}

      {isBool ? (
        <select
          value={rule.value}
          onChange={e => onChange({ value: e.target.value })}
          className="bg-transparent text-sm text-[var(--text-primary)] outline-none cursor-pointer flex-1"
        >
          <option value="true">yes</option>
          <option value="false">no</option>
        </select>
      ) : (
        <input
          type="text"
          value={rule.value}
          onChange={e => onChange({ value: e.target.value })}
          placeholder="value…"
          className="flex-1 bg-transparent text-sm text-[var(--text-primary)] outline-none placeholder:text-[var(--text-muted)]"
        />
      )}

      <button
        onClick={onRemove}
        className="p-1 rounded transition-colors hover:bg-[var(--bg-hover)]"
        style={{ color: 'var(--text-muted)' }}
      >
        <TrashIcon size={12} />
      </button>
    </div>
  )
}
