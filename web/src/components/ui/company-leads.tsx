import { IconCheck, IconBrandLinkedin, IconPhone, IconLoader2 } from '@tabler/icons-react'
import { Badge } from '@/components/ui/badge'
import { CopyEmail } from '@/components/ui/copy-email'
import { LeadStatusBadges } from '@/components/ui/lead-status-badges'
import { cn } from '@/lib/utils'
import type { CompanyRecord } from '@/lib/api'

type LeadRow = NonNullable<CompanyRecord['leads']>[number]

interface CompanyLeadsProps {
  leads?: CompanyRecord['leads'] | null
  // When `selectable`, each lead gets a checkbox (for bulk email reveal) and a
  // per-person "Reveal cell" button (the separate, pricier phone waterfall).
  // Used on the Accounts page; the Database drawer leaves these off and renders
  // the original read-only list.
  selectable?: boolean
  selectedApolloIds?: Set<string>
  onToggleLead?: (apolloId: string) => void
  onRevealPhone?: (lead: LeadRow) => void
  isRevealingPhone?: (apolloId: string) => boolean
  phoneEmpty?: (apolloId: string) => boolean
}

// Cached Apollo leads attached to a company - the decision-makers found via
// the Sales Agent's lead step OR the sweep's auto-associate. Shared by the
// Database drawer (read-only) and the Accounts expansion (selectable, with
// per-person phone reveal). Renders nothing when no leads have been attached.
export function CompanyLeads({
  leads,
  selectable = false,
  selectedApolloIds,
  onToggleLead,
  onRevealPhone,
  isRevealingPhone,
  phoneEmpty,
}: CompanyLeadsProps) {
  if (!leads || leads.length === 0) return null
  const enrichedCount = leads.filter((l) => l.enriched).length
  return (
    <div className="rounded-lg border border-amber-400/50 dark:border-amber-400/40 bg-amber-400/[0.05] p-3">
      <div className="text-[10px] uppercase tracking-wider text-amber-700 dark:text-amber-400 font-semibold mb-2">
        Leads ({leads.length}, {enrichedCount} enriched)
      </div>
      <div className="space-y-1.5">
        {leads.map((l, i) => {
          const apolloId = l.apolloId || null
          const checked = !!(apolloId && selectedApolloIds?.has(apolloId))
          const revealing = !!(apolloId && isRevealingPhone?.(apolloId))
          const noMobile = !!(apolloId && phoneEmpty?.(apolloId))
          // Offer the phone reveal until we've waterfall-checked this person
          // (phoneCheckedAt). The number from search is usually a business line;
          // this fetches the personal cell. Hidden once checked.
          const canRevealPhone = selectable && !!apolloId && !l.phoneCheckedAt
          return (
            <div
              key={apolloId || i}
              className="flex items-center gap-2 rounded-md border border-white/30 dark:border-white/10 bg-white/30 dark:bg-white/[0.02] backdrop-blur-md px-2.5 py-1.5"
            >
              {selectable && apolloId && (
                <input
                  type="checkbox"
                  checked={checked}
                  onChange={() => onToggleLead?.(apolloId)}
                  onClick={(e) => e.stopPropagation()}
                  className="h-3.5 w-3.5 accent-sky-500 shrink-0"
                  title="Select for bulk email reveal"
                />
              )}
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2 flex-wrap">
                  <span className="font-medium">{`${l.firstName || ''} ${l.lastName || ''}`.trim() || '(unknown)'}</span>
                  {l.enriched && (
                    <Badge variant="success" className="text-[9px] px-1.5 py-0 gap-0.5">
                      <IconCheck className="h-2 w-2" />
                      Enriched
                    </Badge>
                  )}
                </div>
                <div className="text-muted-foreground text-xs">{l.title || '-'}</div>
                <div className="flex items-center gap-2 mt-1.5">
                  <LeadStatusBadges email={l.email} phone={l.phone} linkedinUrl={l.linkedinUrl} phoneChecking={revealing} />
                </div>
                <div className="flex flex-wrap items-center gap-x-3 gap-y-0.5 text-[10px] text-muted-foreground mt-1">
                  {l.email && (
                    <span className="inline-flex items-center">
                      <CopyEmail email={l.email} />
                      {l.emailStatus === 'verified' && <span className="text-emerald-600 ml-1">✓</span>}
                    </span>
                  )}
                  {!l.email && l.hasEmail && <span className="italic">Email un-revealed</span>}
                  {l.linkedinUrl && (
                    <a
                      href={l.linkedinUrl}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="flex items-center gap-1 hover:text-foreground"
                    >
                      <IconBrandLinkedin className="h-2.5 w-2.5" /> LinkedIn
                    </a>
                  )}
                  {l.phone && (
                    <a href={`tel:${l.phone}`} className="flex items-center gap-1 hover:text-foreground">
                      {l.phone}
                    </a>
                  )}
                  {canRevealPhone && (
                    <button
                      type="button"
                      onClick={(e) => { e.stopPropagation(); onRevealPhone?.(l) }}
                      disabled={revealing}
                      title="Reveal this person's mobile/cell via Apollo waterfall (uses 1 Apollo mobile credit). Runs in the background — a few minutes."
                      className={cn(
                        'inline-flex items-center gap-1 rounded border px-1.5 py-0.5 text-[10px] transition-colors',
                        'border-sky-500/40 text-sky-700 dark:text-sky-300 hover:bg-sky-500/10 disabled:opacity-50',
                      )}
                    >
                      {revealing ? <IconLoader2 className="h-2.5 w-2.5 animate-spin" /> : <IconPhone className="h-2.5 w-2.5" />}
                      {revealing ? 'Revealing…' : 'Reveal cell'}
                    </button>
                  )}
                  {noMobile && !revealing && (
                    <span className="inline-flex items-center gap-1 text-muted-foreground/80">
                      <IconPhone className="h-2.5 w-2.5" /> no mobile on file
                    </span>
                  )}
                </div>
              </div>
            </div>
          )
        })}
      </div>
    </div>
  )
}
