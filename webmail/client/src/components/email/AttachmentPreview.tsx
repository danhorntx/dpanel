import { useEffect } from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import { XIcon, DownloadSimpleIcon, FileIcon } from '@phosphor-icons/react'
import { attachments as attachmentsApi } from '@/lib/api'
import type { EmailAttachment } from '@/types/email'

export interface AttachmentPreviewProps {
  open:        boolean
  emailId:     string | null
  index:       number
  attachment:  EmailAttachment | null
  onClose:     () => void
}

/**
 * Modal overlay that previews an attachment. Images (image/*) render inline
 * as <img>; PDFs render in a sandboxed <iframe>; everything else shows a
 * generic "no preview available — click Download" panel.
 *
 * The user can dismiss with Escape or by clicking the backdrop.
 */
export function AttachmentPreview({ open, emailId, index, attachment, onClose }: AttachmentPreviewProps) {
  // Esc to dismiss — captured at the window level so it works even if focus
  // is inside the iframe.
  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { e.preventDefault(); onClose() }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open, onClose])

  const hasTarget = open && emailId && attachment
  const previewUrl = hasTarget ? attachmentsApi.url(emailId!, index) : ''
  const downloadUrl = hasTarget ? attachmentsApi.url(emailId!, index, { download: true }) : ''

  const ct = attachment?.contentType ?? ''
  const isImage = ct.startsWith('image/')
  const isPdf   = ct === 'application/pdf'
  const canPreview = isImage || isPdf

  return (
    <AnimatePresence>
      {hasTarget && (
        <motion.div
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={{ duration: 0.12 }}
          className="fixed inset-0 z-[70] flex flex-col"
          style={{ background: 'rgba(0,0,0,0.85)', backdropFilter: 'blur(4px)' }}
          onClick={onClose}
        >
          {/* Toolbar */}
          <div
            className="flex items-center gap-3 px-5 py-3 flex-shrink-0"
            style={{ background: 'rgba(13,12,26,0.85)', borderBottom: '1px solid var(--border-subtle)' }}
            onClick={e => e.stopPropagation()}
          >
            <FileIcon size={14} weight="duotone" style={{ color: 'var(--accent)' }} />
            <div className="flex-1 min-w-0">
              <div className="text-sm font-medium text-[var(--text-primary)] truncate">
                {attachment!.filename}
              </div>
              <div className="text-[11px] text-[var(--text-muted)]">
                {attachment!.contentType} · {formatBytes(attachment!.size)}
              </div>
            </div>
            <a
              href={downloadUrl}
              download={attachment!.filename}
              className="flex items-center gap-1.5 px-3 py-1.5 rounded-md text-xs font-medium transition-colors"
              style={{
                background: 'var(--accent-faint)',
                border:     '1px solid var(--border-accent)',
                color:      'var(--accent)',
              }}
            >
              <DownloadSimpleIcon size={12} weight="bold" />
              Download
            </a>
            <button
              onClick={onClose}
              title="Close (Esc)"
              className="p-1.5 rounded-md transition-colors hover:bg-[var(--bg-hover)]"
              style={{ color: 'var(--text-muted)' }}
            >
              <XIcon size={13} weight="bold" />
            </button>
          </div>

          {/* Body */}
          <div
            className="flex-1 flex items-center justify-center overflow-auto p-6"
            onClick={e => e.stopPropagation()}
          >
            {isImage && (
              <img
                src={previewUrl}
                alt={attachment!.filename}
                className="max-w-full max-h-full rounded-lg"
                style={{ boxShadow: '0 16px 60px rgba(0,0,0,0.6)' }}
              />
            )}
            {isPdf && (
              <iframe
                src={previewUrl}
                title={attachment!.filename}
                className="rounded-lg"
                style={{
                  width:  'min(96vw, 1100px)',
                  height: 'min(85vh, 1400px)',
                  background: '#fff',
                  border: 0,
                  boxShadow: '0 16px 60px rgba(0,0,0,0.6)',
                }}
              />
            )}
            {!canPreview && (
              <div
                className="rounded-xl px-8 py-10 text-center max-w-md"
                style={{ background: 'var(--bg-overlay)', border: '1px solid var(--border-subtle)' }}
              >
                <div
                  className="w-14 h-14 rounded-xl flex items-center justify-center mx-auto mb-4"
                  style={{ background: 'var(--accent-faint)', border: '1px solid var(--border-accent)' }}
                >
                  <FileIcon size={24} style={{ color: 'var(--accent)' }} />
                </div>
                <p className="text-sm font-medium text-[var(--text-primary)] mb-1">
                  No inline preview available
                </p>
                <p className="text-xs text-[var(--text-muted)] mb-5">
                  This file type ({attachment!.contentType || 'unknown'}) can&apos;t be previewed in the app.
                </p>
                <a
                  href={downloadUrl}
                  download={attachment!.filename}
                  className="inline-flex items-center gap-1.5 px-4 py-2 rounded-md text-sm font-semibold"
                  style={{ background: 'var(--accent)', color: 'var(--accent-contrast)' }}
                >
                  <DownloadSimpleIcon size={13} weight="bold" />
                  Download {formatBytes(attachment!.size)}
                </a>
              </div>
            )}
          </div>
        </motion.div>
      )}
    </AnimatePresence>
  )
}

function formatBytes(bytes: number): string {
  if (bytes < 1024)            return `${bytes} B`
  if (bytes < 1024 * 1024)     return `${(bytes / 1024).toFixed(1)} KB`
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`
  return `${(bytes / 1024 / 1024 / 1024).toFixed(2)} GB`
}
