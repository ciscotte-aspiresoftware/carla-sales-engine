import { useEffect, useRef, useState } from 'react'
import { NavLink } from 'react-router-dom'
import {
  IconRobot,
  IconCompass,
  IconDatabase,
  IconMapPin,
  IconSparkles,
  IconChevronDown,
  IconCheck,
  IconBuildingStore,
  IconClipboardCheck,
  IconDashboard,
  IconMail,
  IconTemplate,
  IconBook,
  IconUsers,
  IconBrandLinkedin,
  IconSettings,
  IconWorldSearch,
  IconActivity,
  IconCoin,
  IconMailForward,
} from '@tabler/icons-react'
import { cn } from '@/lib/utils'
import { useSidebar } from '@/context/sidebar-context'
import { useWorkspace } from '@/context/workspace-context'
import { useAccountsCount } from '@/context/accounts-count-context'

// Sidebar that supports collapsed (icon-only, 3.5rem) and expanded (15rem)
// states via the sidebar context. Width transitions smoothly; labels fade
// in/out. Hidden entirely on mobile - for the demo we expect desktop only.
//
// Header acts as a workspace switcher: clicking it opens a popover listing
// every portfolioCompany found across the ICPs (plus an "All Companies"
// option). Picking one filters Database + Coverage by default to that
// company's data; "All Companies" is the cross-view used for M&A leadership
// perspectives. Per-page filter chips can still narrow further within the
// chosen workspace, so picking a workspace doesn't lock anything.

// Sidebar organized into groups that mirror the lead-funnel mental model,
// top to bottom: configure what you want → run the pipeline to find it →
// reach out.
//
//   (top, no label)   Dashboard - the home/overview surface.
//   CONFIGURATION     What you tune occasionally - defines what the
//                     pipeline below is looking for (ICPs, Email Templates).
//   PIPELINE          The lead discovery + qualification flow, in order:
//                       Coverage (machine discovery) →
//                       New Leads (one-off sourcing, currently hidden) →
//                       Accounts (human review) →
//                       Database (long-term archive) →
//                       People (contacts pulled from those companies).
//                     A user can mentally trace a single lead from top
//                     to bottom of this group.
//   OUTREACH          The end of the funnel - reaching out to a person:
//                       Email Generation (Sales Agent) + LI Message.
//
// Each group has a small uppercase section label between dividers.
// Collapsed sidebar mode hides the labels (just icons) but keeps the
// dividers visible as a visual break.
interface NavItem {
  to: string
  label: string
  icon: any
  end?: boolean
  // Slug for the live-pill-count source. Lets us attach a number badge
  // to specific nav items without hardcoding the lookup in the render
  // loop - add new badge sources by extending the switch in NavBadge.
  badge?: 'accounts-pending'
}
interface NavGroup {
  label: string | null   // null = no header (top section)
  items: NavItem[]
}
const NAV_GROUPS: NavGroup[] = [
  {
    label: null,
    items: [
      { to: '/', label: 'Dashboard', icon: IconDashboard, end: true },
    ],
  },
  {
    label: 'Configuration',
    items: [
      { to: '/icp', label: 'ICPs', icon: IconSparkles, end: false },
      // Templates sit next to ICPs since both are "what you tune
      // occasionally" rather than daily-action surfaces. ICPs define
      // what we look for; Templates define how we reach out once we
      // find a fit.
      { to: '/templates', label: 'Email Templates', icon: IconTemplate, end: false },
    ],
  },
  {
    label: 'Pipeline',
    items: [
      { to: '/coverage', label: 'Coverage', icon: IconMapPin, end: false },
      // New Leads (one-off sourcing) is hidden from the sidebar for now -
      // the /sourcing route stays live, just not surfaced in nav. Restore
      // this line to bring it back.
      // { to: '/sourcing', label: 'New Leads', icon: IconCompass, end: false },
      { to: '/accounts', label: 'My Accounts', icon: IconClipboardCheck, end: false, badge: 'accounts-pending' },
      { to: '/database', label: 'Database', icon: IconDatabase, end: false },
      { to: '/people', label: 'People', icon: IconUsers, end: false },
    ],
  },
  {
    // Outreach - the daily "reach out to a person" surfaces. Email
    // Generation (Sales Agent) + LI Message are the two outreach channels.
    // Sits after Pipeline since reaching out is the end of the funnel:
    // discover/qualify (Pipeline) → contact (Outreach).
    label: 'Outreach',
    items: [
      { to: '/email', label: 'Email Generation', icon: IconMail, end: false },
      { to: '/li-message', label: 'LI Message', icon: IconBrandLinkedin, end: false },
      { to: '/sequences', label: 'Sequences', icon: IconMailForward, end: false },
    ],
  },
  // CRM group hidden from the sidebar. The /discover route is still live
  // (App.tsx still mounts <DiscoverPage />) so any direct bookmarks survive
  // - we just don't surface it in the nav anymore. Re-add this block to
  // bring it back; matches the same "kept-but-hidden" pattern as /sourcing.
  // {
  //   label: 'CRM',
  //   items: [
  //     { to: '/discover', label: 'Discover (CRM)', icon: IconWorldSearch, end: false },
  //   ],
  // },
  {
    label: 'Help',
    items: [
      { to: '/wiki', label: 'Wiki', icon: IconBook, end: false },
    ],
  },
  {
    label: 'Settings',
    items: [
      { to: '/activity', label: 'Activity Log', icon: IconActivity, end: false },
      { to: '/costs', label: 'Costs', icon: IconCoin, end: false },
      { to: '/admin', label: 'Admin', icon: IconSettings, end: false },
    ],
  },
]

// Backwards-compat - IconRobot was used by the old Sales Agent nav entry.
// Kept imported above to avoid unused-import noise from icon libs that
// tree-shake oddly; remove if/when no nav item references it.
void IconRobot
// IconWorldSearch sits in the same bucket - currently referenced only by
// the commented-out CRM/Discover nav group. Keep the import so flipping
// that group back on is a one-line change.
void IconWorldSearch

// Pull the first letter of the workspace name for the badge. In "All
// Companies" mode we show an asterisk to signal cross-portfolio scope -
// the badge was previously the "B" of "Bluebird" (the tool brand), which
// confusingly overlapped with Bluebird Auto Rental Systems (a portfolio
// company). Using a non-letter glyph for the all-companies state makes
// the visual unambiguous.
function workspaceInitial(workspace: string): string {
  if (!workspace) return '∗'
  const trimmed = workspace.trim()
  return trimmed.charAt(0).toUpperCase() || '∗'
}

// Display label that goes next to the badge. Full workspace name when
// one is picked; "All Companies" when not. Crucially does NOT fall back
// to "Bluebird" - that string is the name of a portfolio company, not a
// useful label for cross-portfolio scope.
function workspaceTitle(workspace: string): string {
  if (!workspace) return 'All Companies'
  return workspace
}

export function AppSidebar() {
  const { collapsed } = useSidebar()
  const { workspace, setWorkspace, availableWorkspaces } = useWorkspace()
  const [pickerOpen, setPickerOpen] = useState(false)
  const popoverRef = useRef<HTMLDivElement | null>(null)

  const visibleGroups = NAV_GROUPS

  // Close the popover on outside click - standard popover behavior.
  // useEffect clean-up removes the listener so we don't leak when the
  // sidebar unmounts (which happens on a page route change in some apps,
  // not ours, but the cleanup is still correct).
  useEffect(() => {
    if (!pickerOpen) return
    const handler = (e: MouseEvent) => {
      if (popoverRef.current && !popoverRef.current.contains(e.target as Node)) {
        setPickerOpen(false)
      }
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [pickerOpen])

  const initial = workspaceInitial(workspace)
  const title = workspaceTitle(workspace)

  return (
    <aside
      className={cn(
        // Glass treatment matching the cards: very translucent + heavy
        // backdrop-blur so the photo backdrop shows through, with a hairline
        // border-right for definition. Light mode: warm white wash. Dark
        // mode: barely-there white tint that lets the dark photo show.
        'hidden md:flex md:flex-col border-r border-white/40 dark:border-white/10 bg-white/30 dark:bg-white/[0.04] backdrop-blur-xl transition-[width] duration-200 ease-in-out relative',
        collapsed ? 'md:w-14' : 'md:w-60'
      )}
    >
      {/* Workspace switcher header. Clicking opens a popover with the list
          of portfolio companies. The whole row is clickable so the user
          doesn't have to aim at a tiny chevron. */}
      <button
        type="button"
        onClick={() => setPickerOpen((v) => !v)}
        title={collapsed ? `${title} - click to switch workspace` : 'Switch workspace'}
        className={cn(
          'flex h-14 items-center gap-2 px-3 border-b border-white/30 dark:border-white/10 transition-colors hover:bg-white/20 dark:hover:bg-white/5 cursor-pointer text-left',
          collapsed && 'justify-center'
        )}
      >
        <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md bg-gradient-to-br from-sky-400 to-sky-600 text-white text-sm font-bold shadow-md shadow-sky-500/20">
          {initial}
        </div>
        {!collapsed && (
          <>
            <div className="flex flex-col leading-tight overflow-hidden flex-1 min-w-0">
              <span className="text-sm font-semibold text-sidebar-foreground truncate">{title}</span>
              <span className="text-[10px] text-muted-foreground truncate">
                {workspace ? 'Workspace · click to switch' : 'Cross-portfolio view · click to switch'}
              </span>
            </div>
            <IconChevronDown
              className={cn(
                'h-3.5 w-3.5 text-muted-foreground transition-transform shrink-0',
                pickerOpen && 'rotate-180',
              )}
            />
          </>
        )}
      </button>

      {/* Popover - anchored to the sidebar header, slides out below. Floats
          above the rest of the sidebar so it isn't clipped by the nav. */}
      {pickerOpen && (
        <div
          ref={popoverRef}
          className={cn(
            'absolute z-30 top-14 left-2 right-2 rounded-md border border-white/40 dark:border-white/10 bg-white/95 dark:bg-slate-900/95 backdrop-blur-xl shadow-lg shadow-black/10 dark:shadow-black/40 py-1.5',
            collapsed && 'left-full ml-2 right-auto w-56',
          )}
        >
          <div className="px-3 py-1 text-[10px] uppercase tracking-wider text-muted-foreground border-b border-border/40 mb-1">
            Switch workspace
          </div>
          {/* "All Companies" - the default cross-view. Always shown so the
              user can return to the unscoped view from any workspace. */}
          <WorkspaceOption
            label="All Companies"
            sub="Cross-view across every portfolio company"
            selected={!workspace}
            onPick={() => { setWorkspace(''); setPickerOpen(false) }}
          />
          {availableWorkspaces.length > 0 && (
            <div className="my-1 border-t border-border/40" />
          )}
          {availableWorkspaces.map((w) => (
            <WorkspaceOption
              key={w}
              label={w}
              selected={workspace === w}
              onPick={() => { setWorkspace(w); setPickerOpen(false) }}
            />
          ))}
          {availableWorkspaces.length === 0 && (
            <div className="px-3 py-2 text-xs text-muted-foreground italic">
              No portfolio companies yet. Add one on an ICP via the ICPs page.
            </div>
          )}
        </div>
      )}

      <nav className="flex-1 px-2 py-3 overflow-y-auto">
        {visibleGroups.map((group, gIdx) => (
          <div key={gIdx} className={cn(gIdx > 0 && 'mt-3 pt-3 border-t border-white/30 dark:border-white/10')}>
            {/* Section header - small uppercase label. Hidden in collapsed
                mode (only icons + dividers are kept). The first group is
                unlabeled (the top "daily" items don't need a header). */}
            {!collapsed && group.label && (
              <div className="px-2.5 pb-1 text-[10px] uppercase tracking-wider text-muted-foreground/70 font-semibold">
                {group.label}
              </div>
            )}
            <div className="space-y-1">
              {group.items.map((item) => (
                <NavLink
                  key={item.to}
                  to={item.to}
                  end={item.end}
                  title={collapsed ? item.label : undefined}
                  className={({ isActive }) =>
                    cn(
                      'relative flex items-center gap-2 rounded-md px-2.5 py-2 text-sm font-medium transition-colors',
                      isActive
                        ? 'bg-sidebar-accent text-sidebar-accent-foreground'
                        : 'text-sidebar-foreground hover:bg-sidebar-accent hover:text-sidebar-accent-foreground',
                      collapsed && 'justify-center'
                    )
                  }
                >
                  <item.icon className="h-4 w-4 shrink-0" />
                  {!collapsed && <span className="truncate flex-1">{item.label}</span>}
                  {item.badge && <NavBadge slug={item.badge} collapsed={collapsed} />}
                </NavLink>
              ))}
            </div>
          </div>
        ))}
      </nav>
    </aside>
  )
}

// Inline count badge for a nav item - currently used by My Accounts to
// surface "N pending reviews" without the user needing to open the page.
// Hidden when the count is zero (no point yelling about an empty queue)
// and rendered as a tiny dot in collapsed mode (no room for a number).
//
// Color is amber to match the Pending lane styling on the Accounts page
// - visual continuity so a user clicking the pill lands on a screen
// where the same color codes "this is your queue."
function NavBadge({ slug, collapsed }: { slug: 'accounts-pending'; collapsed: boolean }) {
  const { pendingCount } = useAccountsCount()
  // Future slugs can be wired in here without touching the render loop.
  const count = slug === 'accounts-pending' ? pendingCount : 0
  if (count <= 0) return null
  if (collapsed) {
    // Tiny dot anchored to the icon - just a presence indicator since
    // there's no width for a number in a 14px-wide collapsed sidebar.
    return (
      <span
        className="absolute top-1 right-1 h-1.5 w-1.5 rounded-full bg-amber-500 shadow shadow-amber-500/30"
        aria-label={`${count} pending`}
      />
    )
  }
  return (
    <span className="ml-1 inline-flex items-center justify-center min-w-[1.5rem] h-5 px-1.5 rounded-full bg-amber-500/15 text-amber-700 dark:text-amber-300 text-[10px] font-semibold tabular-nums shrink-0">
      {count > 999 ? '999+' : count}
    </span>
  )
}

// Single row in the workspace picker popover. Shown with a check icon when
// it's the active selection so the user can see at a glance where they
// already are; click anywhere on the row to switch.
function WorkspaceOption({
  label,
  sub,
  selected,
  onPick,
}: {
  label: string
  sub?: string
  selected: boolean
  onPick: () => void
}) {
  return (
    <button
      type="button"
      onClick={onPick}
      className={cn(
        'w-full flex items-start gap-2 px-3 py-1.5 text-left text-sm transition-colors',
        selected
          ? 'bg-sky-500/10 text-sky-700 dark:text-sky-300'
          : 'hover:bg-muted/40 text-foreground',
      )}
    >
      <IconBuildingStore className="h-3.5 w-3.5 mt-0.5 shrink-0 opacity-70" />
      <div className="flex-1 min-w-0">
        <div className="font-medium truncate">{label}</div>
        {sub && <div className="text-[10px] text-muted-foreground truncate">{sub}</div>}
      </div>
      {selected && <IconCheck className="h-3.5 w-3.5 shrink-0 mt-0.5 text-sky-500" />}
    </button>
  )
}
