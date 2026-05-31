// /wiki - quick-reference user guide. Single scrollable page with
// collapsible sections so the operator can scan-and-expand whichever
// surface they want to learn about. No external doc dependency — the
// content lives here as React markup, easy to extend.

import { useState } from 'react'
import { Card, CardContent } from '@/components/ui/card'
import { GLASS, GLASS_SUBTLE } from '@/lib/glass'
import { cn } from '@/lib/utils'
import { Link } from 'react-router-dom'
import {
  IconBook,
  IconChevronRight,
  IconRocket,
  IconMapPin,
  IconSparkles,
  IconCompass,
  IconClipboardCheck,
  IconDatabase,
  IconMail,
  IconTemplate,
  IconShieldCheck,
  IconSettings,
  IconAlertTriangle,
} from '@tabler/icons-react'

interface Section {
  id: string
  title: string
  icon: React.ComponentType<{ className?: string }>
  blurb: string
  body: React.ReactNode
}

const SECTIONS: Section[] = [
  {
    id: 'start',
    title: 'Getting started',
    icon: IconRocket,
    blurb: 'Demo vs Real mode, where to begin.',
    body: (
      <>
        <p>
          BlueBird boots in <b>Demo mode</b> by default — every pipeline returns stubbed responses
          and the sweep cron is paused. The sidebar footer shows a sky-blue dot when you're in demo.
          You see the pre-seeded fixtures on Database / Coverage / Accounts, but no API credits are
          spent and nothing reaches Scrapingdog / Firecrawl / OpenAI / Apollo.
        </p>
        <p className='mt-2'>
          When you're ready for real sweeps, open <Link to='/admin' className='underline'>Admin</Link>{' '}
          and flip the toggle to <b>Real</b>. The footer dot turns emerald. Demo fixtures are hidden,
          credit-spending routes go live, and the sweep cron is allowed to run — but it starts <i>paused</i>{' '}
          so you can choose when to start a session by clicking <b>Resume sweeping</b> on the Coverage page.
        </p>
        <p className='mt-2'>
          The recommended first-real-mode sequence:
        </p>
        <ol className='list-decimal pl-6 mt-1 space-y-1'>
          <li>Open <Link to='/icp' className='underline'>ICPs</Link>, review the vertical / portfolio company / search terms / classifier criteria for whichever ICP you want to run.</li>
          <li>Open <Link to='/coverage' className='underline'>Coverage</Link>, pick that ICP, click <b>Seed cells</b> (for the ICP's cities) or <b>Fill country</b> (for a wider sweep).</li>
          <li>Hit <b>Resume sweeping</b>. The cron picks the highest-priority cell, runs it, sweeps a second, then auto-pauses. You'll see a yellow "Session paused — budget exhausted" card in the activity feed.</li>
          <li>Repeat Resume → 2 more cells → pause cycle. Companies found land in <Link to='/database' className='underline'>Database</Link> and qualified ones show up on <Link to='/accounts' className='underline'>My Accounts</Link> for review.</li>
        </ol>
      </>
    ),
  },
  {
    id: 'sweep',
    title: 'The sweep lifecycle',
    icon: IconMapPin,
    blurb: 'How a cell goes from pending → complete, the per-session budget, priority order.',
    body: (
      <>
        <p>
          Each cell on the Coverage globe is one Scrapingdog search target — a lat/lng plus a search
          radius. Cells start as <b>pending</b> (sky-blue), flip to <b>scanning</b> (pulsing red) when
          the cron picks them, and finish as <b>complete</b> (emerald) or <b>empty</b> (gray) depending
          on whether any non-chain businesses survived the filters.
        </p>
        <p className='mt-2'>
          The cron ticks every 30 seconds. Each tick processes <b>one cell per ICP</b>, then breaks.
          Per ICP, the cron stops at the <b>BLUEBIRD_SWEEP_BUDGET</b> (default <b>2</b>) cells per
          session. Hitting the cap fires a "Session paused" event in the activity feed and the cron
          parks itself. Clicking <b>Resume sweeping</b> POSTs <code>/api/grid/reset-budget</code>{' '}
          which zeros the counter and unparks the cron for another N cells.
        </p>
        <p className='mt-2'>
          <b>Priority order</b> within an ICP (so the budget gets spent on the highest-yield cells first):
        </p>
        <ol className='list-decimal pl-6 mt-1 space-y-0.5'>
          <li>Tier-1 cells (your <code>icp.cities[]</code> hex grids) before any Tier-2 country-fill cell</li>
          <li>Within Tier-2: <b>Urban</b> (population ≥ 50k) → <b>Airport</b> → <b>Suburban</b> (≥ 5k) → <b>Rural</b> (&lt; 5k or sparse backstop)</li>
          <li>Then alphabetical by parent city, then seed order as tiebreakers</li>
        </ol>
        <p className='mt-2'>
          Per cell the pipeline runs Scrapingdog once per search term (3 terms × 5 credits = 15
          credits per cold cell), filters chains and non-target types, dedupes against the existing
          database, then for each survivor: Firecrawl scrape (or cache hit) → GPT classify → upsert.
          The scrape stage and classify stage run as a two-pipe pipeline so company N+1's scrape
          starts while company N is being classified — about 20-30% faster than fully sequential.
        </p>
        <p className='mt-2'>
          If the server is killed mid-sweep, the next boot's <code>rescueOrphanedScanningCells()</code>{' '}
          flips any stuck <code>scanning</code> cells back to <code>pending</code> so the cron picks them
          up cleanly on the next Resume.
        </p>
      </>
    ),
  },
  {
    id: 'icps',
    title: 'ICPs',
    icon: IconSparkles,
    blurb: 'Vertical + search terms + classifier criteria. Drives what Coverage looks for.',
    body: (
      <>
        <p>
          An ICP (Ideal Customer Profile) defines what the sweep pipeline considers a match. Each
          ICP has:
        </p>
        <ul className='list-disc pl-6 mt-1 space-y-1'>
          <li><b>Vertical</b> — drives scrape-cache pooling. ICPs sharing a vertical reuse each other's cached scrapes (sibling-ICP fanout = nearly free).</li>
          <li><b>Portfolio Company</b> — links the ICP to a Valsoft portfolio company. Drives the workspace filter and the "from" persona in email generation.</li>
          <li><b>Countries + Cities</b> — primary sweep targets. The seeder builds hex grids around each city; metro radius scales with city population.</li>
          <li><b>Search terms</b> — Scrapingdog Maps queries (e.g. <code>car rental</code>, <code>vehicle hire</code>, <code>auto rental</code>). Each term × cell = 5 Scrapingdog credits.</li>
          <li><b>Coverage</b> — which density tiers (urban / suburban / rural / airports) the "Fill country" action seeds.</li>
          <li><b>Classifier criteria</b> — the structured fields (target description, customer types, exclude types/companies, extra notes) that compose into the GPT system prompt the classifier sees on every page.</li>
          <li><b>Custom prompt</b> — toggle to write the classifier prompt by hand instead of composing from structured fields. Useful for non-standard verticals.</li>
        </ul>
        <p className='mt-2'>
          The <b>"How GPT sees this"</b> preview in each ICP editor shows the actual system prompt
          the classifier sends to GPT, byte-for-byte. The user message is filled in per-page at sweep
          time (page title + scraped markdown, capped at ~12k chars).
        </p>
        <p className='mt-2'>
          When an ICP runs a sweep, every company it touches gets fanned out to sibling ICPs in the
          same vertical — they each re-classify against the cached scrape with their own prompt. So
          adding a second Car Rental ICP costs ~$0 in extra Scrapingdog/Firecrawl credits, just a few
          GPT calls.
        </p>
      </>
    ),
  },
  {
    id: 'coverage',
    title: 'Coverage',
    icon: IconMapPin,
    blurb: 'Seed cells, watch the sweep, inspect any cell.',
    body: (
      <>
        <p>
          The Coverage page is where you control sweeps. It has a globe and a city list. Pick an ICP
          from the dropdown to see its cells and stats.
        </p>
        <p className='mt-2'>
          <b>Seed cells</b> generates hex-grid cells around each city in the ICP's <code>cities[]</code>{' '}
          list. <b>Fill country</b> generates Tier-2 cells across the whole country bbox using the ICP's
          coverage tier toggles (urban/suburban/rural/airports).
        </p>
        <p className='mt-2'>
          The activity feed (right side) streams events live:
        </p>
        <ul className='list-disc pl-6 mt-1 space-y-1'>
          <li>▶ <b>cell_start</b> — sweep just kicked off a new cell</li>
          <li>· <b>company_scrape_start / classify_start</b> — per-company progress (used by the live progress bar)</li>
          <li>✓ <b>company_qualified</b> — GPT classified this company as a match</li>
          <li>✗ <b>company_rejected</b> — classified as a no-match (reason in the row)</li>
          <li>◀ <b>cell_complete</b> — cell finished, stats shown</li>
          <li>⏸ <b>session_summary</b> — budget hit, cron paused. Tally of cells / companies / qualified shown.</li>
        </ul>
        <p className='mt-2'>
          <b>Resume sweeping</b> clears the per-ICP session counter so the cron continues. If you
          want to wipe cells and start fresh, <b>Reset all</b> clears the grid (companies stay).
        </p>
      </>
    ),
  },
  {
    id: 'sourcing',
    title: 'New Leads (Sourcing)',
    icon: IconCompass,
    blurb: 'One-off Maps searches for specific cities or globe clicks.',
    body: (
      <>
        <p>
          New Leads is for ad-hoc sourcing — point at a city or click anywhere on the globe and run
          a single Scrapingdog Maps search. Useful for spot-checking an area or finding companies
          outside your ICP's seeded city list without triggering a full Coverage sweep.
        </p>
        <p className='mt-2'>
          Each search is 5 Scrapingdog credits (one Maps page = ~20 raw results). After chain and
          type filtering you see surviving companies in a table. Hit <b>Send to Sales Agent</b> on a
          row to push it into the Email Generation pipeline as a paste-classified company.
        </p>
        <p className='mt-2'>
          The <b>Recent scans</b> card at the bottom shows your scan history (city, query, page,
          time, kept count). Hit the X to dismiss it if it's covering the globe; it reopens on the
          next scan.
        </p>
      </>
    ),
  },
  {
    id: 'accounts',
    title: 'My Accounts',
    icon: IconClipboardCheck,
    blurb: 'Pending / Confirmed / Rejected review lanes for qualified companies.',
    body: (
      <>
        <p>
          When the sweep classifies a company as a match for an ICP, it lands in the <b>Pending</b>{' '}
          lane on My Accounts for that ICP. The page filters by workspace (portfolio company) and
          ICP. Click a card to expand and review the classification + signals.
        </p>
        <p className='mt-2'>
          Three actions per card:
        </p>
        <ul className='list-disc pl-6 mt-1 space-y-1'>
          <li><b>Confirm</b> — moves the card to the Confirmed lane. Marks <code>reviews[icpId].decision = 'confirmed'</code>.</li>
          <li><b>Reject</b> — moves to Rejected with an optional canned reason + free-text note.</li>
          <li><b>Sales Agent</b> — hops to <Link to='/email' className='underline'>Email Generation</Link> pre-loaded with this company's classification, so you skip the URL paste step.</li>
        </ul>
        <p className='mt-2'>
          Reviews are per-ICP. The same company can be Confirmed by ICP A and Rejected by ICP B if
          they share a vertical but have different targeting criteria. Undo any decision to put the
          card back in Pending.
        </p>
      </>
    ),
  },
  {
    id: 'email',
    title: 'Email Generation (Sales Agent)',
    icon: IconMail,
    blurb: 'Classify → leads → email pipeline.',
    body: (
      <>
        <p>
          The Email Generation page (formerly "Sales Agent") runs the per-URL pipeline:
        </p>
        <ol className='list-decimal pl-6 mt-1 space-y-1'>
          <li><b>Paste a URL</b> (or arrive pre-classified from My Accounts / Sourcing). Firecrawl scrapes the site, GPT classifies it under the standard car-rental prompt.</li>
          <li><b>Decision-makers</b> — clicking <i>Find decision-makers</i> hits Apollo for the top 3 contacts by seniority (search only, no enrichment credit spent yet).</li>
          <li><b>Outreach email</b> — pick a lead → enrich that one lead (1 Apollo credit) → GPT drafts the email using the selected template's system prompt and sender persona.</li>
        </ol>
        <p className='mt-2'>
          The page is a 2-column layout: <b>Report</b> on the left (full height, scrolls internally),
          <b> Leads</b> top right (compact, scrolls), <b>Email</b> bottom right (long-form, gets the most height).
        </p>
        <p className='mt-2'>
          Template auto-selection: if you arrived from My Accounts (with an ICP context),
          the page auto-picks the template bound to that ICP via <code>defaultForIcps</code>.
          Otherwise you pick from the template dropdown. See the next section for templates.
        </p>
      </>
    ),
  },
  {
    id: 'templates',
    title: 'Email Templates',
    icon: IconTemplate,
    blurb: 'Sender persona + system prompt per portfolio company / ICP binding.',
    body: (
      <>
        <p>
          Email Templates define <i>how</i> we reach out once a company qualifies. Each template
          carries:
        </p>
        <ul className='list-disc pl-6 mt-1 space-y-1'>
          <li><b>Sender persona</b> — first name, last name, title, company, sign-off, email. Drives the &quot;From&quot; line and the email body's voice ("I'm Fazal, Group MD at Bluebird…").</li>
          <li><b>Language</b> — dropdown with full names (English, Dutch, French, etc.). GPT writes the full email in that language.</li>
          <li><b>Voice</b> — short descriptor injectable into the system prompt via <code>{`{{voice}}`}</code>.</li>
          <li><b>System prompt</b> — the rules block fed to GPT. Encodes tone, structure, what to mention, what to skip.</li>
          <li><b>Default for ICPs</b> — list of ICP IDs this template auto-selects for. So a lead under a given ICP lands on that ICP's bound template without picking.</li>
        </ul>
        <p className='mt-2'>
          The page is a 2-column layout: narrow list rail on the left (compact name + portfolio +
          language pills), wide editor on the right. Templates are filtered by the active workspace
          — switch portfolios on the sidebar to scope the visible list.
        </p>
      </>
    ),
  },
  {
    id: 'database',
    title: 'Database',
    icon: IconDatabase,
    blurb: 'Read-only inspector of every classified company.',
    body: (
      <>
        <p>
          The Database page is the canonical view of <code>api/data/companies.json</code> — every company
          the classifier has touched. Filters across the top: <b>Vertical</b>, <b>Portfolio Company</b>,
          <b> ICP</b>, and a <b>Qualified / Rejected / All</b> tab (only meaningful when an ICP is selected,
          since match status is per-ICP).
        </p>
        <p className='mt-2'>
          Each row shows the per-ICP classification when an ICP filter is active (so a sibling ICP's
          stricter verdict doesn't accidentally show as the canonical answer). Click a row to expand
          and see the full classification + cached Apollo leads.
        </p>
        <p className='mt-2'>
          <b>List vs Map</b> toggle — map view plots companies at their stored lat/lng (Scrapingdog
          captures these on first scrape). Useful for visualising regional density.
        </p>
        <p className='mt-2'>
          The banner at the top tells you whether you're viewing demo fixtures or real sweep
          results. In Real mode, demo records (source tagged <code>:demo</code>) are filtered out at
          the API level so you only see genuine sweep output.
        </p>
      </>
    ),
  },
  {
    id: 'admin',
    title: 'Admin',
    icon: IconShieldCheck,
    blurb: 'Demo/Real mode toggle, background style.',
    body: (
      <>
        <p>
          Hidden under the sidebar footer pill. Two controls:
        </p>
        <ul className='list-disc pl-6 mt-1 space-y-1'>
          <li><b>Mode (Demo / Real)</b> — global server-side flag persisted in <code>api/data/mode.json</code>. Demo = stubbed responses, sweep cron parked, demo fixtures shown. Real = live API calls, sweep cron eligible (still paused-by-default per session), demo fixtures hidden.</li>
          <li><b>Background (Photo / Plain)</b> — purely visual. Photo = the default cinematic backdrop. Plain = flat white in light mode / near-black in dark mode (with glass cards boosted for readability). Per-browser preference, persisted to localStorage.</li>
        </ul>
        <p className='mt-2'>
          Flipping Mode is reversible. Real-sweep results write to the same <code>companies.json</code>{' '}
          alongside demo fixtures — the filter just hides demo rows when Real is active. So you can
          flip back to Demo to show off the seeded data without losing your real sweep data.
        </p>
      </>
    ),
  },
  {
    id: 'arch',
    title: 'Under the hood',
    icon: IconSettings,
    blurb: 'Architecture, caches, where data lives.',
    body: (
      <>
        <p>
          Quick map of the moving parts:
        </p>
        <ul className='list-disc pl-6 mt-1 space-y-1'>
          <li><code>api/data/companies.json</code> — every classified company. Per-ICP verdicts under <code>classifications[icpId]</code>; legacy <code>classification</code> field pins the latest write for back-compat.</li>
          <li><code>api/data/grid.json</code> — every sweep cell with state + tier + density + lat/lng.</li>
          <li><code>api/data/scrape-cache/</code> — Firecrawl markdown indexed by domain. Sibling ICPs in the same vertical hit this cache and skip Firecrawl entirely.</li>
          <li><code>api/data/search-log.json</code> — Scrapingdog dedup. Records (vertical, ~1km area, term) tuples already searched. Sibling ICPs sharing the vertical skip searches already paid for nearby.</li>
          <li><code>api/data/sources.json</code> — Sourcing page scan history + Scrapingdog Places detail cache.</li>
          <li><code>api/data/icps.json</code> — ICP definitions.</li>
          <li><code>api/data/email-templates.json</code> — Email template records.</li>
          <li><code>api/data/mode.json</code> — current Demo/Real mode.</li>
        </ul>
        <p className='mt-2'>
          Sweep pipeline order:
        </p>
        <ol className='list-decimal pl-6 mt-1 space-y-1'>
          <li>Cron picks the next pending cell (Tier-1 first, then density-prioritised Tier-2).</li>
          <li>Cell flips to <code>scanning</code>; activity event fires.</li>
          <li>Scrapingdog search per non-deduped term (5 credits each).</li>
          <li>Cross-term dedup, chain blocklist, type filter.</li>
          <li>Dedup against <code>companies.json</code> domains. Skip already-classified.</li>
          <li>For each survivor (2-stage pipeline, max 1 Firecrawl + 1 GPT in flight): scrape (cache or Firecrawl) → classify → upsert.</li>
          <li>Auto-fanout: sibling ICPs in the same vertical re-classify the cached markdown (GPT only, no scrape).</li>
          <li>Cell flips to <code>complete</code> or <code>empty</code>; activity event with totals.</li>
          <li>If session budget exhausted, cron parks itself and emits a session_summary event.</li>
        </ol>
      </>
    ),
  },
  {
    id: 'troubleshooting',
    title: 'Troubleshooting',
    icon: IconAlertTriangle,
    blurb: 'Common surprises and how to fix them.',
    body: (
      <>
        <p>Common things you might hit:</p>
        <ul className='list-disc pl-6 mt-1 space-y-1'>
          <li>
            <b>Resumed sweeping but the cell flipped straight to "empty"</b> — the search log already
            has every term for that ~1km area from an earlier session. Either trust the area is
            covered, or run a fresh sweep with new search terms on the ICP.
          </li>
          <li>
            <b>Red cells stuck on the globe after a restart</b> — the rescue function runs on cron
            startup and should flip them back to pending. Check the boot log for "Rescued N orphaned
            scanning cell(s) → pending". If they're still red, refresh the Coverage page.
          </li>
          <li>
            <b>Database shows companies as "No match" when an ICP qualified them</b> — make sure the
            ICP filter is set in the Database. Without it, the row reads the last-write classification
            (sibling-ICP fanout might have flipped it). With an ICP filter, the row reads that ICP's
            specific verdict.
          </li>
          <li>
            <b>Real mode flipped but no API calls happen</b> — confirm the <code>.env</code> keys are
            populated and the server restarted. Boot log line <code>[Bluebird API] Env loaded: ...</code>{' '}
            shows which key flags are set.
          </li>
          <li>
            <b>Sweep cron isn't ticking</b> — check Admin for Demo mode (sweep parked) or the boot log
            for "paused — press Resume sweeping". Cron boots paused in Real mode by default.
          </li>
        </ul>
      </>
    ),
  },
]

export default function WikiPage() {
  // All sections collapsed by default; opening one doesn't close others
  // (so the reader can compare adjacent topics).
  const [openIds, setOpenIds] = useState<Set<string>>(new Set(['start']))
  const toggle = (id: string) => {
    setOpenIds((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  return (
    <div className='max-w-4xl mx-auto p-6 space-y-6'>
      <div>
        <div className='flex items-center gap-3'>
          <IconBook className='h-6 w-6 text-sky-500' />
          <h1 className='text-2xl font-semibold'>Wiki</h1>
        </div>
        <p className='text-sm text-muted-foreground mt-2'>
          Quick reference for how BlueBird works — pipeline mechanics, where to click, what each surface does.
          Tap a section header to expand. Sections stay independent so you can have several open at once.
        </p>
      </div>

      <div className='space-y-3'>
        {SECTIONS.map((section, i) => {
          const open = openIds.has(section.id)
          const Icon = section.icon
          return (
            <Card key={section.id} className={cn(GLASS, 'bb-card-in')} style={{ animationDelay: `${i * 30}ms` }}>
              <button
                type='button'
                onClick={() => toggle(section.id)}
                className='w-full text-left px-4 py-3 flex items-center gap-3 hover:bg-foreground/[0.03] transition-colors'
              >
                <span className='flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-sky-500/10 text-sky-600 dark:text-sky-400'>
                  <Icon className='h-4 w-4' />
                </span>
                <span className='flex-1 min-w-0'>
                  <span className='block text-sm font-semibold'>{section.title}</span>
                  <span className='block text-xs text-muted-foreground truncate'>{section.blurb}</span>
                </span>
                <IconChevronRight className={cn('h-4 w-4 text-muted-foreground transition-transform shrink-0', open && 'rotate-90')} />
              </button>
              {open && (
                <CardContent className={cn(GLASS_SUBTLE, 'mx-3 mb-3 p-4 text-sm leading-relaxed [&_code]:rounded [&_code]:bg-muted/40 [&_code]:px-1 [&_code]:py-[1px] [&_code]:text-[12px] [&_code]:font-mono [&_a]:text-sky-600 dark:[&_a]:text-sky-400 [&_a]:underline')}>
                  {section.body}
                </CardContent>
              )}
            </Card>
          )
        })}
      </div>

      <p className='text-xs text-muted-foreground text-center pt-2'>
        Found something missing or wrong? The wiki content lives in <code className='text-foreground'>web/src/pages/wiki.tsx</code> — easy to edit.
      </p>
    </div>
  )
}
