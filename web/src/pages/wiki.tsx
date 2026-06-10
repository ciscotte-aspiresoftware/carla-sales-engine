// /wiki - quick-reference user guide. Single scrollable page with
// collapsible sections so the operator can scan-and-expand whichever
// surface they want to learn about. No external doc dependency - the
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
  IconUsers,
  IconMail,
  IconBrandLinkedin,
  IconTemplate,
  IconShieldCheck,
  IconSettings,
  IconCloud,
  IconAlertTriangle,
  IconActivity,
  IconLayoutDashboard,
  IconSend,
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
    blurb: 'Where to begin a real sweep.',
    body: (
      <>
        <p>
          Atlas runs live against Scrapingdog / Firecrawl / OpenAI / Apollo. The sweep cron
          boots <i>paused</i> so credits are only spent when you explicitly start a session by
          clicking <b>Resume sweeping</b> on the Coverage page.
        </p>
        <p className='mt-2'>
          The recommended first-sweep sequence:
        </p>
        <ol className='list-decimal pl-6 mt-1 space-y-1'>
          <li>Open <Link to='/icp' className='underline'>ICPs</Link>, review the vertical / portfolio company / search terms / classifier criteria for whichever ICP you want to run.</li>
          <li>Open <Link to='/coverage' className='underline'>Coverage</Link>, pick that ICP, click <b>Seed cells</b> (for the ICP's cities) or <b>Fill country</b> (for a wider sweep).</li>
          <li>Hit <b>Resume sweeping</b>. The cron picks the highest-priority cell, runs it, sweeps a second, then auto-pauses. You'll see a yellow "Session paused - budget exhausted" card in the activity feed.</li>
          <li>Repeat Resume → 2 more cells → pause cycle. Companies found land in <Link to='/database' className='underline'>Database</Link>, qualified ones show up on <Link to='/accounts' className='underline'>My Accounts</Link> for review, and their contacts appear under <Link to='/people' className='underline'>People</Link>.</li>
        </ol>
      </>
    ),
  },
  {
    id: 'dashboard',
    title: 'Dashboard',
    icon: IconLayoutDashboard,
    blurb: 'At-a-glance home page: recent sweeps, recent reclassify jobs, totals.',
    body: (
      <>
        <p>
          The Dashboard is the landing surface. Top row: counters for total companies / qualified
          accounts / pending review / leads with verified email - each scoped by the active workspace.
        </p>
        <p className='mt-2'>
          <b>Recent sweep sessions</b> - last few <code>sweep_sessions</code> rows with ICP, scope
          (city/country), state (running / paused / done), cells scanned, qualified count, credit
          spend. Click a row to jump to Coverage filtered to that ICP + scope so you can resume or
          inspect the trail. Lets you see what's still in flight at a glance without opening
          Coverage.
        </p>
        <p className='mt-2'>
          <b>Recent reclassify jobs</b> - last few queued reclassify runs from the ICP editor's
          Reclassify tab. Each card shows ICP name, total rows / processed / new verdicts,
          state, and an inline progress bar that updates over Socket.IO while the worker chews
          through the queue. Click for the full job detail.
        </p>
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
          Each cell on the Coverage globe is one Scrapingdog search target - a lat/lng plus a search
          radius. Cells start as <b>pending</b> (sky-blue), flip to <b>scanning</b> (pulsing red) when
          the cron picks them, and finish as <b>complete</b> (emerald) or <b>empty</b> (gray) depending
          on whether any non-chain businesses survived the filters.
        </p>
        <p className='mt-2'>
          The cron ticks every 5 seconds (configurable via <code>BLUEBIRD_SWEEP_TICK_MS</code>). Each
          tick processes <b>one cell per ICP</b>, then breaks. Per ICP, the cron stops at the{' '}
          <b>BLUEBIRD_SWEEP_BUDGET</b> (default <b>2</b>) cells per session. Hitting the cap fires a
          "Session paused" event in the activity feed and the cron parks itself. Clicking{' '}
          <b>Resume sweeping</b> POSTs <code>/api/grid/reset-budget</code> which zeros the counter
          and unparks the cron for another N cells.
        </p>
        <p className='mt-2'>
          <b>Pause mid-cell.</b> Clicking <b>Pause</b> during an active sweep sets a{' '}
          <code>pauseRequested</code> flag the pipeline reads at three checkpoints inside the cell:
        </p>
        <ol className='list-decimal pl-6 mt-1 space-y-1'>
          <li><b>Inside the Scrapingdog search loop</b> - between search terms and between pages. A partially-fetched page does NOT get logged to <code>search_log</code> (so Resume re-runs that term cheaply), a fully-completed term does (so Resume skips it). When the search loop bails, <code>allRaw</code> is discarded and the cell exits without spending Firecrawl on the partial harvest.</li>
          <li><b>At the top of the scrape IIFE</b> - between companies, before kicking off the next Firecrawl call. Stops the scrape pipe cleanly so classification of in-flight pages can drain.</li>
          <li><b>At the top of the classify IIFE</b> - between companies, before the next GPT call.</li>
        </ol>
        <p className='mt-2'>
          When the pipeline bails, it writes a <code>pause_checkpoint</code> JSON blob to the cell
          row (next survivor index, cumulative counters, surviving domain list) and the cell exits
          back to <code>state='pending'</code>. The next Resume rehydrates from the checkpoint and
          skips straight to the saved index - no Scrapingdog re-spend, no re-classifying companies
          already done. The Coverage page shows a "Pausing..." indicator until the checkpoint lands,
          and a "Paused session" banner with Resume CTA appears any time a cell has an unfinished
          checkpoint.
        </p>
        <p className='mt-2'>
          <b>Pause reasons.</b> The cron tracks <i>why</i> it stopped - <code>'manual'</code>{' '}
          (operator hit Pause), <code>'budget'</code> (per-session cell cap hit),{' '}
          <code>'no_work'</code> (no pending cells in scope), or <code>'boot'</code> (cron has just
          started and is waiting for first Resume). The blue "Paused session" banner ONLY renders
          for <code>'manual'</code> pauses - budget/no-work auto-pauses surface as quieter status
          chips instead of nagging-for-Resume banners.
        </p>
        <p className='mt-2'>
          <b>Scope-aware Resume.</b> Resume Sweeping always carries the view you're currently looking
          at - city dropdown (e.g. <i>Amsterdam</i>) or country fill (e.g. <i>NL</i>). The cron locks
          to that <i>(ICP, scope)</i> tuple for the session, so its budget is spent only on cells in
          that scope. Pause Amsterdam mid-sweep, switch to a country-fill view, hit Resume - the cron
          picks up the new scope's pending cells without Amsterdam's Tier-1 cells stealing the queue.
          Each scope's progress lives in the cell states themselves, so coming back to Amsterdam
          later resumes exactly where you left off. The header shows a <b>"Last: …"</b> chip per ICP
          with the most-recent scope and its done/total cell count.
        </p>
        <p className='mt-2'>
          <b>Priority order</b> <i>within</i> the active scope (so the budget gets spent on the
          highest-yield cells first):
        </p>
        <ol className='list-decimal pl-6 mt-1 space-y-0.5'>
          <li>Tier-1 cells (your <code>icp.cities[]</code> hex grids) before any Tier-2 country-fill cell - inside scope='all'. Within a scoped view, only that view's cells are eligible.</li>
          <li>Within Tier-2: <b>Urban</b> (population ≥ 50k) → <b>Airport</b> → <b>Suburban</b> (≥ 5k) → <b>Rural</b> (&lt; 5k or sparse backstop)</li>
          <li>Then alphabetical by parent city, then seed order as tiebreakers</li>
        </ol>
        <p className='mt-2'>
          Per cell the pipeline runs Scrapingdog once per search term (3 terms × 5 credits = 15
          credits per cold cell), filters chains and non-target types, dedupes against the existing
          database, then for each survivor: Firecrawl scrape (or cache hit) → GPT classify → upsert.
          The scrape stage and classify stage run as a two-pipe pipeline so company N+1's scrape
          starts while company N is being classified - about 20-30% faster than fully sequential.
        </p>
        <p className='mt-2'>
          Companies found <b>with no website</b> still get saved (name, phone, address, Google Maps
          link) and land in the <b>Needs check</b> lane on My Accounts for manual review, since there's
          nothing to scrape or auto-classify.
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
          <li><b>Vertical</b> - drives scrape-cache pooling. ICPs sharing a vertical reuse each other's cached scrapes (sibling-ICP fanout = nearly free).</li>
          <li><b>Portfolio Company</b> - links the ICP to a Valsoft portfolio company. Drives the workspace filter and the "from" persona in email generation.</li>
          <li><b>Countries + Cities</b> - primary sweep targets. The seeder builds hex grids around each city; metro radius scales with city population.</li>
          <li><b>Search terms</b> - Scrapingdog Maps queries (e.g. <code>car rental</code>, <code>vehicle hire</code>, <code>auto rental</code>). Each term × cell = 5 Scrapingdog credits.</li>
          <li><b>Coverage</b> - which density tiers (urban / suburban / rural / airports) the "Fill country" action seeds.</li>
          <li><b>Classifier criteria</b> - the structured fields (target description, customer types, exclude types/companies, extra notes) that compose into the GPT system prompt the classifier sees on every page.</li>
          <li><b>Custom prompt</b> - toggle to write the classifier prompt by hand instead of composing from structured fields. Useful for non-standard verticals.</li>
          <li><b>Report template</b> - optional markdown skeleton. When enabled, a qualified company gets a GPT-filled report against this template (rejected companies get a short why-rejected note instead).</li>
        </ul>
        <p className='mt-2'>
          The <b>"How GPT sees this"</b> preview in each ICP editor shows the actual system prompt
          the classifier sends to GPT, byte-for-byte. The user message is filled in per-page at sweep
          time (page title + scraped markdown, capped at ~12k chars).
        </p>
        <p className='mt-2'>
          When an ICP runs a sweep, every company it touches gets fanned out to sibling ICPs in the
          same vertical - they each re-classify against the cached scrape with their own prompt. So
          adding a second Car Rental ICP costs ~$0 in extra Scrapingdog/Firecrawl credits, just a few
          GPT calls.
        </p>
        <p className='mt-2'>
          <b>Reclassify tab.</b> Each ICP editor has a dedicated Reclassify tab that lists every
          company already touched by the classifier, with a definition-hash badge per row:{' '}
          <b>"up-to-date"</b> (the row was classified under the current <code>classifyPrompt</code>)
          vs <b>"stale"</b> (the prompt has changed since). Default selection is stale-only, so the
          rerun button only burns GPT credits on rows that genuinely need a re-decision. The list
          collapses into per-city + per-country toggle chips (historical cities the ICP no longer
          targets are greyed and disable selection unless re-toggled). Each row has a glanceable
          strip - city / phone / Google rating - and expands to the full address + website link.
        </p>
        <p className='mt-2'>
          <b>Reclassify is a persistent queue, not a foreground run.</b> Hitting "Rerun" enqueues a{' '}
          <code>reclassify_jobs</code> row + one <code>reclassify_results</code> child per company,
          and a background worker chews through them serially (so a long reclassify doesn't block
          the sweep cron or HTTP requests). The job survives a server restart - on boot the worker
          picks up any <code>state='queued'</code> or <code>state='running'</code> jobs and resumes.
          Progress streams over Socket.IO so the ICP editor's progress bar and the Dashboard's
          recent-jobs card update live. Cancel a job from the ICP editor to flip remaining rows to{' '}
          <code>state='cancelled'</code>.
        </p>
        <p className='mt-2'>
          <b>Search-term staleness.</b> Adding a new term to an ICP marks every completed cell whose{' '}
          <code>search_terms[]</code> doesn't include it as stale. A "Rescan stale terms" button on
          Coverage runs ONLY the new terms against the first 10 stale cells (cheapest possible
          partial-recover sweep). Removing a term doesn't trigger anything - removals can't surface
          new companies.
        </p>
        <p className='mt-2'>
          <b>AI Autofill (Generate / Improve).</b> The ICP editor has a "Generate from description"
          and "Improve" pair that GPT-fills the structured fields from a one-sentence pitch. Two
          context sources are baked into the prompt so the output isn't generic:
        </p>
        <ul className='list-disc pl-6 mt-1 space-y-1'>
          <li><b>Portfolio company briefs.</b> Picking <i>Bluebird</i>, <i>Thermeon</i>, or <i>NedFox</i> injects a hand-written brief covering the product, the actual target customers, and what to exclude (so e.g. NedFox-Garden autofill knows the seven verticals NedFox sells into and produces language-correct local terms - "tuincentrum" in NL, "garden centre" in UK, "jardinería" in ES).</li>
          <li><b>Google Maps semantics + TYPE-A vs TYPE-B detection.</b> The system prompt teaches the model that Scrapingdog Maps queries act as a <i>category filter</i> on the place graph - so an ICP for "POS resellers that support garden centres" must produce terms like <code>"POS reseller"</code> / <code>"EPOS supplier"</code> / <code>"retail IT consultant"</code>, NOT <code>"garden centre support"</code> (which returns garden centres). Trigger words like <i>support / partner / reseller / consultant / installer / vendor / supplier / integrator / VAR</i> flip the prompt into TYPE-B (B2B service-provider) mode where the search terms target the providers, not their end-customers.</li>
        </ul>
        <p className='mt-2'>
          <b>Custom prompt + REP OVERRIDE.</b> Toggling "Use custom prompt" lets you write the
          classifier system prompt by hand. Any block prefixed with <code>{`{{REP OVERRIDE}}`}</code>{' '}
          is hard-pinned at the top of the final prompt - useful for one-off corrections ("treat
          companies in the BENELUX as in-scope even if their stated region says EU only"). The
          override block survives prompt regeneration; the rest of the structured fields don't.
        </p>
        <p className='mt-2'>
          <b>AI Fill for report templates.</b> If the ICP has a report template, the editor exposes
          a sparkles button that GPT-fills the markdown skeleton from a one-paragraph hint (target
          headings, what each section should answer, which signals matter). Faster than writing the
          skeleton by hand and easier to iterate on.
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
          <li>▶ <b>cell_start</b> - sweep just kicked off a new cell</li>
          <li>· <b>company_scrape_start / classify_start</b> - per-company progress (used by the live progress bar)</li>
          <li>✓ <b>company_qualified</b> - GPT classified this company as a match</li>
          <li>✗ <b>company_rejected</b> - classified as a no-match (reason in the row)</li>
          <li>◀ <b>cell_complete</b> - cell finished, stats shown</li>
          <li>⏸ <b>session_summary</b> - budget hit, cron paused. Tally of cells / companies / qualified shown.</li>
        </ul>
        <p className='mt-2'>
          The activity feed is a live <b>Socket.IO</b> push - multiple people can watch the same sweep
          at once and see identical events in real time (there's still only one sweep running on the
          server). <b>Resume sweeping</b> clears the per-ICP session counter so the cron continues. If
          you want to wipe cells and start fresh, <b>Reset all</b> clears the grid (companies stay).
        </p>
        <p className='mt-2'>
          <b>At-a-glance signals on Coverage:</b>
        </p>
        <ul className='list-disc pl-6 mt-1 space-y-1'>
          <li><b>Pending-cells badge on each ICP</b> in the dropdown - a small number showing how many cells are still <code>pending</code> for that ICP across all scopes. Useful for picking the ICP with actual work left.</li>
          <li><b>Paused-session banner</b> - shown when any cell has an unfinished <code>pause_checkpoint</code> AND the pause reason was <code>'manual'</code>. The banner's scope label (city / country) is rendered HUGE so you know exactly which view will be resumed. One-click Resume rehydrates the saved state and continues that exact cell.</li>
          <li><b>Last-paused session chip</b> - a row above the action row that shows the most recent <i>manually-paused</i> session for the active ICP. Click the chip to switch the picker to that session's scope (workspace + ICP + city/country). Auto-hides when the chip's scope already matches the current picker, so it never duplicates state you can see.</li>
          <li><b>"Resume sweeping" vs "Sweep" label.</b> The primary action button reads <i>Resume sweeping</i> when the currently-picked scope has been touched before (any cell with a <code>pause_checkpoint</code>, <code>placesFound &gt; 0</code>, or a non-null <code>lastScannedAt</code>) and <i>Sweep</i> when it's a fresh scope. Both invoke the same endpoint; the label is purely a hint to the operator about whether they're continuing or starting clean.</li>
          <li><b>Stale-sweep banner</b> - shown when the active ICP has cells whose <code>search_terms[]</code> are behind the ICP's current term list. One-click "Rescan stale terms" runs only the new terms on the first 10 affected cells.</li>
          <li><b>Pause button</b> - appears while a sweep is running. Once clicked, the in-flight cell finishes its current company, writes its checkpoint, and the cron parks itself. Shows "Pausing..." until the checkpoint lands.</li>
          <li><b>Seed + sweep</b> - one-shot for fresh scopes: native <code>window.confirm()</code> dialog (no popover - bulletproof against stuck-button states), then seeds the cells and unparks the cron in a single round trip.</li>
          <li><b>Cell drawer</b> - click any cell on the globe / list to see its lat/lng, density tier, <i>last swept N ago</i> timestamp, last-swept search terms, and any pause checkpoint (cumulative counters + saved index) for resume preview.</li>
        </ul>
      </>
    ),
  },
  {
    id: 'sourcing',
    title: 'New Leads (Sourcing)',
    icon: IconCompass,
    blurb: 'One-off Maps searches - currently hidden from the sidebar.',
    body: (
      <>
        <p>
          New Leads is for ad-hoc sourcing - point at a city or click anywhere on the globe and run
          a single Scrapingdog Maps search. Useful for spot-checking an area or finding companies
          outside your ICP's seeded city list without triggering a full Coverage sweep.
        </p>
        <p className='mt-2'>
          <b>Note:</b> this page is currently <b>hidden from the sidebar</b>, but the route is still
          live at <code>/sourcing</code> - navigate there directly if you need it. (Re-enable the
          sidebar entry in <code>app-sidebar.tsx</code> to bring it back.)
        </p>
        <p className='mt-2'>
          Each search is 5 Scrapingdog credits (one Maps page = ~20 raw results). After chain and
          type filtering you see surviving companies in a table. Hit <b>Send to Sales Agent</b> on a
          row to push it into the Email Generation pipeline as a paste-classified company.
        </p>
      </>
    ),
  },
  {
    id: 'accounts',
    title: 'My Accounts',
    icon: IconClipboardCheck,
    blurb: 'Pending / Confirmed / Rejected / Needs-check review lanes.',
    body: (
      <>
        <p>
          When the sweep classifies a company as a match for an ICP, it lands in the <b>Pending</b>{' '}
          lane on My Accounts for that ICP. The page filters by workspace (portfolio company) and
          ICP. Click a card to expand and review the classification, signals, and any Apollo leads.
        </p>
        <p className='mt-2'>
          Four lanes (tabs at the top):
        </p>
        <ul className='list-disc pl-6 mt-1 space-y-1'>
          <li><b>Pending</b> (amber) - classifier qualified it, you haven't reviewed yet.</li>
          <li><b>Confirmed</b> (emerald) - you approved it. Marks <code>reviews[icpId].decision = 'confirmed'</code>.</li>
          <li><b>Rejected</b> (red) - you declined, with an optional canned reason + free-text note.</li>
          <li><b>Needs check</b> (orange) - companies found with <b>no website</b> (nothing to auto-classify). Shows name / phone / address + a Google Maps link for manual qualification.</li>
        </ul>
        <p className='mt-2'>
          Per card: <b>Confirm</b>, <b>Reject</b>, or <b>Sales Agent</b> (hops to{' '}
          <Link to='/email' className='underline'>Email Generation</Link> pre-loaded with this
          company's classification so you skip the URL paste step). Reviews are per-ICP - the same
          company can be Confirmed by ICP A and Rejected by ICP B if they share a vertical but have
          different criteria. Undo any decision to put the card back in its prior lane.
        </p>
        <p className='mt-2'>
          <b>Recover details (Needs check).</b> A row in Needs check whose Google Maps card came
          back as a stub (no title, missing phone or address - the Scrapingdog search result was
          thin) shows a <b>Recover details (5 credits)</b> button. It re-runs the place lookup
          using the saved <code>dataId</code> → <code>placeId</code> → lat/lng fallback chain, calls
          Scrapingdog Places (5 credits), and merges title / phone / address / rating / review-count
          back into the classification. If the lat/lng fallback also fires it costs 10 credits
          (one search + one Places). Lets a stale stub become a fully reviewable row without
          re-running a whole cell.
        </p>
        <p className='mt-2'>
          GPS fallback links: when phone <i>and</i> address are both missing but the company has
          stored lat/lng, the row still renders a Google Maps button via a lat/lng deep link, so
          you can still eyeball the location.
        </p>
      </>
    ),
  },
  {
    id: 'database',
    title: 'Database',
    icon: IconDatabase,
    blurb: 'Inspector of every classified company + its leads.',
    body: (
      <>
        <p>
          The Database page is the canonical view of every company the classifier has touched.
          Filters across the top: <b>Vertical</b>, <b>Portfolio Company</b>, <b>ICP</b>, and a{' '}
          <b>Qualified / Rejected / All</b> tab (only meaningful when an ICP is selected, since match
          status is per-ICP).
        </p>
        <p className='mt-2'>
          Each row shows the per-ICP classification when an ICP filter is active (so a sibling ICP's
          stricter verdict doesn't accidentally show as the canonical answer). Click a row to expand
          and see the full classification plus the cached <b>Apollo leads</b> - each lead's name,
          title, LinkedIn, and email. Emails are <b>click-to-copy</b>, the lead count is highlighted
          amber, and website / LinkedIn links are clickable straight from the collapsed card.
        </p>
        <p className='mt-2'>
          <b>List vs Map</b> toggle - map view plots companies at their stored lat/lng (Scrapingdog
          captures these on first scrape). Useful for visualising regional density.
        </p>
      </>
    ),
  },
  {
    id: 'people',
    title: 'People',
    icon: IconUsers,
    blurb: 'Flat database of every contact pulled from your companies.',
    body: (
      <>
        <p>
          People is the read-only database of every lead (contact) across every company, with the
          company name shown on each row. It mirrors the Database filter chrome (vertical / ICP /
          portfolio company) plus lead-specific filters: <b>has-LinkedIn-cache</b>,{' '}
          <b>has-verified-email</b>, and free-text search.
        </p>
        <ul className='list-disc pl-6 mt-1 space-y-1'>
          <li><b>Enrich</b> - runs a single Apollo enrichment for that contact (1 credit) to reveal/refresh email; <b>Enrich phone</b> re-checks just the phone.</li>
          <li>A <b>green tick</b> next to an email means Apollo verified it. Emails are click-to-copy.</li>
          <li>Each row expands to show the cached LinkedIn profile + recent posts - a preview of exactly what the email generator will see before you send.</li>
          <li>The "added" badge shows the real date/time the lead was attached.</li>
        </ul>
        <p className='mt-2'>
          (The route is also reachable at <code>/leads</code> for old bookmarks - same page.)
        </p>
      </>
    ),
  },
  {
    id: 'email',
    title: 'Email Generation (Sales Agent)',
    icon: IconMail,
    blurb: 'Pick an ICP → classify → leads → email.',
    body: (
      <>
        <p>
          The Email Generation page (also "Sales Agent") runs the per-URL pipeline. <b>Analyze is
          ICP-specific</b>: pick an ICP from the dropdown next to the URL field first - the Analyze
          button stays greyed out until you do, because every verdict is tied to one ICP.
        </p>
        <ol className='list-decimal pl-6 mt-1 space-y-1'>
          <li><b>Paste a URL</b> (or arrive pre-classified from My Accounts). If this company already has a stored verdict for the chosen ICP, it's served instantly (no scrape, no GPT) - hit <b>Re-classify</b> to force a fresh run against the cached scrape.</li>
          <li><b>Not qualified?</b> A popup lets you skip, try the same company under a <i>different</i> ICP, or <b>Override</b> the verdict to qualified (stamped as a human call, stored for that ICP).</li>
          <li><b>Decision-makers</b> - <i>Find decision-makers</i> hits Apollo for the top contacts by seniority (search only, no enrichment credit yet).</li>
          <li><b>Outreach email</b> - pick a lead → enrich that one lead (1 Apollo credit) → GPT drafts the email using the selected template's system prompt and sender persona.</li>
        </ol>
        <p className='mt-2'>
          <b>Reveal → Selected → Generate workflow.</b> Step 2 (Decision-makers) splits the per-row
          action into two states: a <b>Reveal</b> button to spend the Apollo credit and unmask the
          contact's email, and a <b>Selected</b> badge (green) on the chosen lead. The only{' '}
          <b>Generate email</b> button lives in Step 3 - so there's exactly one "draft now" click
          per session and no confusion about which row's about to be drafted. The page also
          remembers the selected model from the dropdown across re-classifies.
        </p>
        <p className='mt-2'>
          <b>No-leads path.</b> If Apollo returns zero decision-makers (or the company has no
          contacts at all), Step 3 still lets you generate a <i>general</i> outreach email
          addressed to the company - the GPT prompt switches to a "no specific contact" mode that
          leans on company-level signals (classification, scraped about-page snippets) instead of
          per-lead context. Useful for small shops where Apollo has nothing.
        </p>
        <p className='mt-2'>
          <b>Layout.</b> The header keeps the "Sales Agent" title + description on one line; the
          tab toggle between <b>Agent</b> (Steps 1-3) and <b>Email</b> (the drafted message + copy
          button) sits on its own row below the picker so it stays out of the way until an email
          exists. The Email tab is intentionally generous on vertical space so the body and the
          "Copy to clipboard" button are both visible without scrolling.
        </p>
        <p className='mt-2'>
          If you arrived from My Accounts, a <b>Confirm / Reject bar</b> shows at the bottom so you
          can record your review without leaving the page. Template auto-selection: arriving with an
          ICP context auto-picks the template bound to that ICP via <code>defaultForIcps</code>;
          otherwise pick from the dropdown. <b>Custom instructions</b> entered here are wrapped in
          a <code>{`{{REP OVERRIDE}}`}</code> block that gets hard-pinned at the top of the email
          system prompt - the model is told to follow it even if it contradicts the template's
          baseline tone.
        </p>
      </>
    ),
  },
  {
    id: 'sequences',
    title: 'Sequences',
    icon: IconSend,
    blurb: 'Multi-step outreach runs that draft + send a sequence of touchpoints per lead.',
    body: (
      <>
        <p>
          Sequences strings several outreach steps (initial email → follow-up → LinkedIn DM, in any
          order and any count) into one persisted run against a lead snapshot. Each step has its
          own template + delay + channel, drafted ahead of time so you can review the whole
          sequence before any of it goes out.
        </p>
        <p className='mt-2'>
          The page has two surfaces. The <b>runs list</b> is the index of every sequence: lead
          name + company in the same row, step count, current state (drafted / sending / done /
          cancelled), created-at. Click a row to open the <b>run detail</b> with one card per step:
          channel, template, scheduled-for, generated body, and per-step Copy / Edit / Skip.
        </p>
        <p className='mt-2'>
          <b>Lead snapshot is live, not frozen.</b> When a sequence is regenerated, the run
          re-reads the lead from Supabase (not the stale <code>run.contextSnapshot.lead</code>) -
          so a freshly-cached LinkedIn profile or a newly-enriched email shows up immediately
          without manually editing the run. Same logic protects against the "[object Object]" bug
          that used to happen when the posts formatter's structured return was string-coerced into
          the prompt.
        </p>
        <p className='mt-2'>
          <b>LI signal handling.</b> When the cached LinkedIn profile passes the{' '}
          <code>isUsefulLiSummary</code> validator (any of headline / about / posts has real
          content - empty shells from <code>summarizeProfile</code>'s defensive defaults DON'T
          count), the prompt switches to LI-PRIMARY mode: open with a specific LI signal (recent
          post, role change, headline phrase) rather than the company classification. If the cache
          is empty or shell-only, the prompt falls back to classification-only.
        </p>
        <p className='mt-2'>
          <b>Channel filter on the template picker</b> - the Email step picker queries{' '}
          <code>channel='email'</code> and the LinkedIn step picker queries{' '}
          <code>channel='linkedin'</code>, so LI templates never appear in the email dropdown and
          vice versa. The first visible template auto-selects so you never sit on a blank picker.
        </p>
      </>
    ),
  },
  {
    id: 'li-message',
    title: 'LI Message',
    icon: IconBrandLinkedin,
    blurb: 'Scrape a LinkedIn profile + posts → generate an outreach DM/email.',
    body: (
      <>
        <p>
          LI Message generates outreach seeded from a person's LinkedIn signals (headline, about,
          recent posts, role changes) rather than a website classification. Two input modes:
        </p>
        <ul className='list-disc pl-6 mt-1 space-y-1'>
          <li><b>Pick from leads</b> - choose a contact already in the database; uses their cached LinkedIn URL and persists the scrape back so the People page picks it up. The picker shows <b>Name · Company · Title</b> (company in blue) and is scoped to the active workspace. Filtering by an ICP cycles through the people attached to companies in that ICP.</li>
          <li><b>Paste URL</b> - free-form LinkedIn URL, no persistence; an ICP picker is shown so the email still gets a template + tone.</li>
        </ul>
        <p className='mt-2'>
          Once scraped, the right pane has three tabs: <b>Profile</b> / <b>Posts</b> / <b>Email</b>.
          A <b>Custom instruction</b> box lets you steer the draft (e.g. "mention their recent
          promotion") - the prompt enforces that custom instructions are followed.
        </p>
        <p className='mt-2'>
          <b>LI templates.</b> The template picker on this page is scoped to <code>channel=linkedin</code>{' '}
          templates - separate from the Email Generation channel. A LI template carries its own
          system prompt + LinkedIn guidance + sender (e.g. shorter / less formal voice than the
          email equivalent). Templates are managed on the <Link to='/templates' className='underline'>Email
          Templates</Link> page via the <b>Email / LinkedIn</b> tab toggle.
        </p>
      </>
    ),
  },
  {
    id: 'templates',
    title: 'Email Templates (and LinkedIn templates)',
    icon: IconTemplate,
    blurb: 'Sender persona + system prompt, per portfolio company, per channel.',
    body: (
      <>
        <p>
          Templates define <i>how</i> we reach out once a company qualifies. Each portfolio
          company has its own voice (Bluebird = Fazal, Thermeon = Adam, NedFox = Maartje). Each
          template lives on either the <b>Email</b> channel (used by{' '}
          <Link to='/email' className='underline'>Email Generation</Link>) or the <b>LinkedIn</b>{' '}
          channel (used by <Link to='/li-message' className='underline'>LI Message</Link>) -
          toggled via the Email / LinkedIn tab on the templates page. Both channels share the same
          editor + sender model. Each template carries:
        </p>
        <ul className='list-disc pl-6 mt-1 space-y-1'>
          <li><b>Sender persona</b> - first name, last name, title, company, sign-off, email. Drives the "From" line and the body's voice ("I'm Fazal, Group MD at Bluebird…").</li>
          <li><b>Language</b> - full names (English, Dutch, French, etc.). GPT writes the whole email in that language.</li>
          <li><b>Voice</b> - short descriptor injectable into the system prompt via <code>{`{{voice}}`}</code>.</li>
          <li><b>System prompt</b> - the rules block fed to GPT. Encodes tone, structure, what to mention, what to skip.</li>
          <li><b>LinkedIn guidance</b> - optional per-template note on how to use LI signals (which post types to prefer / avoid). Appended to the LI block in the prompt.</li>
          <li><b>Default for ICPs</b> - ICP IDs this template auto-selects for, so a NedFox-Garden lead lands on a NedFox-Garden template without picking.</li>
        </ul>
        <p className='mt-2'>
          The page is a 2-column layout: narrow list rail on the left, wide editor on the right.
          Templates are filtered by the active workspace - switch portfolios on the sidebar to scope
          the visible list.
        </p>
      </>
    ),
  },
  {
    id: 'activity',
    title: 'Activity Log',
    icon: IconActivity,
    blurb: 'Audit trail of every mutation - ICPs, sweeps, reclassifies, outreach, templates.',
    body: (
      <>
        <p>
          The Activity Log is a chronological audit feed of every user-initiated mutation across
          Atlas. It writes to the Supabase <code>user_activity</code> table via the{' '}
          <code>trackActivity('action_name')</code> Express middleware - so adding a new action to
          the log is one middleware attach on the route, no client work.
        </p>
        <p className='mt-2'>
          Currently tracked actions:
        </p>
        <ul className='list-disc pl-6 mt-1 space-y-1'>
          <li><b>ICPs</b> - <code>icp_created</code>, <code>icp_updated</code>, <code>icp_deleted</code>, <code>reclassify_run</code> (now enqueues a persistent job - see Reclassify queue below), <code>reclassify_job_cancelled</code>, <code>rescan_stale_terms</code>, <code>icp_autofill</code></li>
          <li><b>Coverage / sweeps</b> - <code>sweep_resumed</code> (clicking Resume sweeping), <code>sweep_paused</code> (clicking Pause), <code>seed_cells</code></li>
          <li><b>Companies</b> - <code>recover_place_details</code> (the Needs-check stub rescue)</li>
          <li><b>Outreach</b> - <code>email_generated</code>, <code>li_message_generated</code>, <code>sequence_generated</code></li>
          <li><b>Templates</b> - <code>template_created</code>, <code>template_updated</code>, <code>template_deleted</code> (covers both Email + LinkedIn channels - they're one table)</li>
        </ul>
        <p className='mt-2'>
          <b>Page chrome.</b> Toolbar has a 7d / 14d / 30d segmented control + per-action chip
          filters (each with its own icon + color + count). Feed is grouped by Today / Yesterday /
          weekday, each row showing the colored action icon, label, user_id badge, a one-line
          detail (e.g. ICP id from the path, template name from the body), and a relative
          timestamp with full ISO time on hover.
        </p>
        <p className='mt-2'>
          <b>What is NOT tracked.</b> GET reads, per-company sweep events (those live in the
          ephemeral Socket.IO activity feed on Coverage instead), and per-cell completions (too
          noisy - the cron's <code>session_summary</code> event covers a whole resume cycle in one
          line). The sensitive-field sanitizer in <code>middleware/activity.js</code> strips{' '}
          <code>password</code> / <code>secret</code> / <code>token</code> / <code>apiKey</code> /{' '}
          <code>api_key</code> / <code>authorization</code> from request bodies before the row is
          written.
        </p>
      </>
    ),
  },
  {
    id: 'admin',
    title: 'Admin',
    icon: IconShieldCheck,
    blurb: 'Operator-tunable pipeline knobs.',
    body: (
      <>
        <p>
          Every operator knob lives here - background mode, search radii / cell generation, Firecrawl
          scrape-vs-crawl, per-task OpenAI model, LinkedIn scrape settings, conflict-prune. Each row
          is Default vs Custom; changes apply without a restart (radii on the next seed, the rest on
          the next call).
        </p>
        <p className='mt-2'>
          <b>Per-task model dropdowns.</b> There are four independent OpenAI model picks:
        </p>
        <ul className='list-disc pl-6 mt-1 space-y-1'>
          <li><b>Classifier</b> - the per-page classify call (default <code>gpt-4o-mini</code>; the hot path, default kept cheap).</li>
          <li><b>Email / sequence generation</b> - per-step outreach draft.</li>
          <li><b>Report template fill</b> - the per-qualified-company markdown report (default bumped to <code>gpt-4o</code> for narrative quality).</li>
          <li><b>ICP autofill</b> (<code>icpAutomationModel</code>) - the model used by the ICP editor's "Generate from description" / "Improve" / "AI fill report template" actions. Defaults to the smartest available since the structured output drives weeks of sweep spend.</li>
        </ul>
        <p className='mt-2'>
          All four pickers expose the same model list (<code>gpt-4o-mini</code>,{' '}
          <code>gpt-4o</code>, <code>gpt-5</code>) and persist to <code>app_settings</code>; the
          autofill calls re-read on every request so a swap takes effect immediately.
        </p>
        <p className='mt-2'>
          <b>Per-session cell budget</b> (<code>BLUEBIRD_SWEEP_BUDGET</code>) is an env knob, not
          an Admin knob - bump it on the host if you want longer Resume cycles. Cron tick interval
          (<code>BLUEBIRD_SWEEP_TICK_MS</code>) is the same shape.
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
          Data lives in <b>Supabase</b> (Postgres) - the app reads and writes it directly when{' '}
          <code>USE_SUPABASE=true</code>. The old <code>api/data/*.json</code> files remain only as a
          local-dev fallback. The main stores:
        </p>
        <ul className='list-disc pl-6 mt-1 space-y-1'>
          <li><b>companies</b> (+ <b>classifications</b>, <b>reviews</b>, <b>leads</b> tables) - every classified company. Per-ICP verdicts under <code>classifications[icpId]</code>; per-ICP reviews under <code>reviews[icpId]</code>; Apollo contacts as embedded leads. Classifications carry a <code>definition_hash</code> stamping which version of the ICP <code>classifyPrompt</code> produced the verdict - drives the Reclassify tab's stale-vs-up-to-date badge.</li>
          <li><b>grid cells</b> - every sweep cell with state + tier + density + lat/lng. Per-cell metadata includes <code>search_terms[]</code> (which ICP terms this cell was last swept with, drives stale-term detection) and <code>pause_checkpoint</code> JSONB (saved next-survivor index + cumulative counters for mid-cell resume).</li>
          <li><b>scrape_cache</b> - Firecrawl markdown indexed by domain. Sibling ICPs in the same vertical hit this and skip Firecrawl entirely.</li>
          <li><b>search_log</b> - Scrapingdog dedup. Records (vertical, ~1km area, term) tuples already searched, so sibling ICPs skip searches already paid for nearby.</li>
          <li><b>sources / place details</b> - Sourcing scan history + Scrapingdog Places detail cache.</li>
          <li><b>geocode cache</b> - resolved city → lat/lng lookups.</li>
          <li><b>user_activity</b> - audit log for the Activity Log page. One row per mutation (action, user_id, JSON details, created_at). Written via the <code>trackActivity</code> middleware.</li>
          <li><b>icps</b>, <b>email_templates</b>, <b>app_settings</b> - config records. Templates carry a <code>channel</code> field (email | linkedin).</li>
        </ul>
        <p className='mt-2'>
          The live <b>sweep activity feed</b> is in-memory + pushed over Socket.IO; it's ephemeral and
          rebuilt each run (history is also served by <code>/api/grid/activity</code> for cold loads).
        </p>
        <p className='mt-2'>
          Sweep pipeline order:
        </p>
        <ol className='list-decimal pl-6 mt-1 space-y-1'>
          <li>Cron picks the next pending cell (Tier-1 first, then density-prioritised Tier-2).</li>
          <li>Cell flips to <code>scanning</code>; activity event fires.</li>
          <li>Scrapingdog search per non-deduped term (5 credits each).</li>
          <li>Cross-term dedup, chain blocklist, type filter.</li>
          <li>Dedup against existing company domains. Skip already-classified.</li>
          <li>For each survivor (2-stage pipeline, max 1 Firecrawl + 1 GPT in flight): scrape (cache or Firecrawl) → classify → upsert.</li>
          <li>Auto-fanout: sibling ICPs in the same vertical re-classify the cached markdown (GPT only, no scrape).</li>
          <li>Cell flips to <code>complete</code> or <code>empty</code>; activity event with totals.</li>
          <li>If session budget exhausted, cron parks itself and emits a session_summary event.</li>
        </ol>
        <p className='mt-2'>
          <b>API key rotation</b> - Scrapingdog, Apify, and Firecrawl support backup keys
          (<code>SCRAPINGDOG_API_KEY_2…</code>, <code>APIFY_API_TOKEN_2…</code>). When the primary
          key rate-limits or runs out of credit, the client rotates to the next sticky key
          automatically.
        </p>
      </>
    ),
  },
  {
    id: 'hosting',
    title: 'Hosting & deployment',
    icon: IconCloud,
    blurb: 'Where Atlas runs in production and how to redeploy.',
    body: (
      <>
        <p>
          Backend on Render, database on Supabase, frontend static build on Netlify. The frontend
          bakes <code>VITE_API_URL</code> at build time, so rebuilding + re-uploading{' '}
          <code>web/dist</code> is the only way to point at a new backend - you can't change it from
          Netlify's dashboard. Locally, Vite proxies <code>/api</code> + <code>/socket.io</code> to{' '}
          <code>localhost:3001</code> so dev never touches Render. Render's disk is ephemeral, so
          run with <code>USE_SUPABASE=true</code> or you lose state every restart.
        </p>
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
            <b>Resumed sweeping but the cell flipped straight to "empty"</b> - the search log already
            has every term for that ~1km area from an earlier session. Either trust the area is
            covered, or run a fresh sweep with new search terms on the ICP.
          </li>
          <li>
            <b>Red cells stuck on the globe after a restart</b> - the rescue function runs on cron
            startup and should flip them back to pending. Check the boot log for "Rescued N orphaned
            scanning cell(s) → pending". If they're still red, refresh the Coverage page.
          </li>
          <li>
            <b>Database shows companies as "No match" when an ICP qualified them</b> - set the ICP
            filter in the Database. Without it, the row reads the last-write classification (sibling-ICP
            fanout might have flipped it). With an ICP filter, the row reads that ICP's specific verdict.
          </li>
          <li>
            <b>No API calls happen</b> - confirm the env keys are populated and the server restarted.
            Boot log line <code>[Atlas API] Env loaded: ...</code> shows which key flags are set. On
            Render, check the <b>Logs</b> tab.
          </li>
          <li>
            <b>Data isn't persisting on the deployed app</b> - Render's disk is ephemeral. Make sure{' '}
            <code>USE_SUPABASE=true</code> and the Supabase creds are set as Render env vars.
          </li>
          <li>
            <b>Sweep cron isn't ticking</b> - check the boot log for "paused - press Resume
            sweeping". Cron boots paused by default.
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
    <div className='space-y-6'>
      <div>
        <div className='flex items-center gap-3'>
          <IconBook className='h-6 w-6 text-sky-500' />
          <h1 className='text-2xl font-semibold'>Wiki</h1>
        </div>
        <p className='text-sm text-muted-foreground mt-2'>
          Quick reference for how Atlas works - pipeline mechanics, where to click, what each surface does.
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
        Found something missing or wrong? The wiki content lives in <code className='text-foreground'>web/src/pages/wiki.tsx</code> - easy to edit.
      </p>
    </div>
  )
}
