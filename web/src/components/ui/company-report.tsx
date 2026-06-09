import { useState } from 'react'
import { IconSparkles, IconLoader2, IconAlertTriangle } from '@tabler/icons-react'
import { Button } from '@/components/ui/button'
import { Markdown } from '@/components/ui/markdown'
import { generateReport, type CompanyRecord } from '@/lib/api'

// Per-ICP GPT markdown report for a company, plus a generate/regenerate
// button. Shared by the Database drawer and the Accounts detail view.
//
// The report is read from the per-ICP classification (falls back to the
// pinned classification). Generation backfills from the cached scrape via
// /api/companies/:id/generate-report and calls onChanged() to refetch.
export function CompanyReport({
  company,
  icpId,
  onChanged,
}: {
  company: CompanyRecord
  icpId: string
  onChanged: () => void
}) {
  const cls = ((icpId && company.classifications?.[icpId]) || company.classification || {}) as any
  const report: string | undefined = cls.report
  const [generating, setGenerating] = useState(false)
  const [err, setErr] = useState<string | null>(null)

  async function handleGenerate() {
    if (!icpId) { setErr('No ICP in scope - filter to an ICP first.'); return }
    setGenerating(true)
    setErr(null)
    try {
      await generateReport(company.id, icpId)
      onChanged()
    } catch (e: any) {
      setErr(e?.message || 'Report generation failed')
    } finally {
      setGenerating(false)
    }
  }

  return (
    <div>
      <div className="flex items-center justify-between mb-2">
        <div className="text-[10px] uppercase tracking-wider text-muted-foreground">
          Report{icpId ? <span className="ml-1 normal-case tracking-normal opacity-60">· {icpId}</span> : null}
        </div>
        <Button
          size="sm"
          variant="outline"
          onClick={handleGenerate}
          disabled={generating || !icpId}
          className="h-6 gap-1.5 text-[11px] px-2"
          title={icpId ? 'Generate (or refresh) the markdown report from the cached scrape' : 'Filter to an ICP to generate a report'}
        >
          {generating ? <IconLoader2 className="h-3 w-3 animate-spin" /> : <IconSparkles className="h-3 w-3" />}
          {report ? 'Regenerate' : 'Generate report'}
        </Button>
      </div>
      {err && (
        <div className="flex items-start gap-1.5 rounded-md bg-red-500/10 border border-red-500/30 text-red-700 dark:text-red-300 px-2 py-1.5 text-[11px] mb-2">
          <IconAlertTriangle className="h-3 w-3 mt-0.5 shrink-0" />
          <span>{err}</span>
        </div>
      )}
      {report
        ? <div className="rounded-lg border border-white/30 dark:border-white/10 bg-white/40 dark:bg-white/[0.03] p-3 max-h-96 overflow-y-auto"><Markdown source={report} /></div>
        : <div className="text-[11px] text-muted-foreground italic">No report yet. {icpId ? 'Click Generate to build one from the cached scrape.' : 'Filter to an ICP to enable report generation.'}</div>}
    </div>
  )
}