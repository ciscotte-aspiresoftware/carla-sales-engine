import { useState } from 'react'
import { IconCopy, IconCheck } from '@tabler/icons-react'
import { cn } from '@/lib/utils'

// Click-to-copy email. Renders the address (or a short `label` for tight
// spots like badges) with a copy icon; clicking copies the real email to
// the clipboard and flashes a check for ~1.2s. Stops propagation so it
// works inside clickable/expandable cards without triggering them.
export function CopyEmail({
  email,
  label,
  className,
}: {
  email: string
  label?: string
  className?: string
}) {
  const [copied, setCopied] = useState(false)
  const copy = (e: React.SyntheticEvent) => {
    e.stopPropagation()
    navigator.clipboard?.writeText(email)
      .then(() => {
        setCopied(true)
        setTimeout(() => setCopied(false), 1200)
      })
      .catch(() => { /* clipboard blocked - no-op */ })
  }
  return (
    <span
      role="button"
      tabIndex={0}
      onClick={copy}
      onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); copy(e) } }}
      title={copied ? 'Copied!' : `Click to copy ${email}`}
      className={cn('inline-flex items-center gap-1 cursor-pointer hover:underline', className)}
    >
      <span className={label ? '' : 'break-all'}>{copied ? 'Copied!' : (label || email)}</span>
      {copied
        ? <IconCheck className="h-3 w-3 text-emerald-600 shrink-0" />
        : <IconCopy className="h-3 w-3 opacity-50 shrink-0" />}
    </span>
  )
}