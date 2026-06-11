import { IconCheck, IconBrandLinkedin } from '@tabler/icons-react'
import { Badge } from '@/components/ui/badge'
import { CopyEmail } from '@/components/ui/copy-email'
import { LeadStatusBadges } from '@/components/ui/lead-status-badges'
import type { CompanyRecord } from '@/lib/api'

// Cached Apollo leads attached to a company - the decision-makers found via
// the Sales Agent's lead step. Shared by the Database drawer and the
// Accounts "Full report" expansion so both render the identical list (name,
// enriched badge, title, email/verified, LinkedIn). Renders nothing when no
// leads have been attached yet.
export function CompanyLeads({ leads }: { leads?: CompanyRecord['leads'] | null }) {
  if (!leads || leads.length === 0) return null
  const enrichedCount = leads.filter((l) => l.enriched).length
  return (
    <div className="rounded-lg border border-amber-400/50 dark:border-amber-400/40 bg-amber-400/[0.05] p-3">
      <div className="text-[10px] uppercase tracking-wider text-amber-700 dark:text-amber-400 font-semibold mb-2">
        Leads ({leads.length}, {enrichedCount} enriched)
      </div>
      <div className="space-y-1.5">
        {leads.map((l, i) => (
          <div
            key={l.apolloId || i}
            className="flex items-center gap-2 rounded-md border border-white/30 dark:border-white/10 bg-white/30 dark:bg-white/[0.02] backdrop-blur-md px-2.5 py-1.5"
          >
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
                <LeadStatusBadges email={l.email} phone={l.phone} linkedinUrl={l.linkedinUrl} />
              </div>
              <div className="flex flex-wrap gap-x-3 gap-y-0.5 text-[10px] text-muted-foreground mt-1">
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
              </div>
            </div>
          </div>
        ))}
      </div>
    </div>
  )
}