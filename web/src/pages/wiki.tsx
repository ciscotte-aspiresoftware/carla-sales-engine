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
          <code>pauseRequested</code> flag the pipeline reads at each company boundary inside the
          cell. The in-flight cell finishes its current company, writes a{' '}
          <code>pause_checkpoint</code> JSON blob to the cell row (next survivor index, cumulative
          counters, surviving domain list), and bails with <code>state='pending'</code>. The next
          Resume re-hydrates from the checkpoint and skips straight to the saved index - no
          Scrapingdog re-spend, no re-classifying companies already done. The Coverage page shows
          a "Pausing..." indicator until the checkpoint lands, and a "Paused session" banner with
          Resume CTA appears any time a cell has an unfinished checkpoint.
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
          <b>Search-term staleness.</b> Adding a new term to an ICP marks every completed cell whose{' '}
          <code>search_terms[]</code> doesn't include it as stale. A "Rescan stale terms" button on
          Coverage runs ONLY the new terms against the first 10 stale cells (cheapest possible
          partial-recover sweep). Removing a term doesn't trigger anything - removals can't surface
          new companies.
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
          <li><b>Paused-session banner</b> - shown when any cell has an unfinished <code>pause_checkpoint</code>. One-click Resume rehydrates the saved state and continues that exact cell.</li>
          <li><b>Stale-sweep banner</b> - shown when the active ICP has cells whose <code>search_terms[]</code> are behind the ICP's current term list. One-click "Rescan stale terms" runs only the new terms on the first 10 affected cells.</li>
          <li><b>Pause button</b> - appears while a sweep is running. Once clicked, the in-flight cell finishes its current company, writes its checkpoint, and the cron parks itself. Shows "Pausing..." until the checkpoint lands.</li>
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
          If you arrived from My Accounts, a <b>Confirm / Reject bar</b> shows at the bottom so you
          can record your review without leaving the page. Template auto-selection: arriving with an
          ICP context auto-picks the template bound to that ICP via <code>defaultForIcps</code>;
          otherwise pick from the dropdown.
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
          <li><b>ICPs</b> - <code>icp_created</code>, <code>icp_updated</code>, <code>icp_deleted</code>, <code>reclassify_run</code>, <code>rescan_stale_terms</code></li>
          <li><b>Coverage / sweeps</b> - <code>sweep_resumed</code> (clicking Resume sweeping), <code>sweep_paused</code> (clicking Pause)</li>
          <li><b>Outreach</b> - <code>email_generated</code>, <code>li_message_generated</code></li>
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
