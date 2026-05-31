"use client"

import Link from "next/link"
import { usePathname, useRouter } from "next/navigation"
import { useState } from "react"
import {
  LayoutDashboard,
  Users,
  Megaphone,
  Package,
  Activity,
  ChevronRight,
  Car,
  Briefcase,
  RotateCcw,
  ShieldCheck,
  Sun,
  Moon,
  Coins,
  Settings as SettingsIcon,
} from "lucide-react"
import { cn } from "@/lib/utils"
import { api } from "@/lib/api"
import { useTheme } from "@/components/ThemeProvider"
import { useVertical } from "@/lib/vertical-context"

/** Sidebar branding per vertical. Icon and color tone are vertical-specific
 * (so the sidebar reflects the active vertical at a glance); the label
 * stays "SDR Engine" because the engine itself is vertical-agnostic. To add
 * a new vertical, drop a new entry here mapping its pack id to an icon.
 * Falls back to Briefcase + sky tone for unknown verticals. */
const VERTICAL_BRANDING: Record<string, {
  icon: React.ElementType
  bg: string
  subtitleColor: string
  activeNav: string
  activeNavBg: string
  chevron: string
}> = {
  car_rental: {
    icon: Car,
    bg: "bg-violet-600",
    subtitleColor: "text-violet-400",
    activeNav: "text-violet-400",
    activeNavBg: "bg-violet-600/20",
    chevron: "text-violet-500",
  },
}

const FALLBACK_BRANDING = {
  icon: Briefcase,
  bg: "bg-gray-500",
  subtitleColor: "text-gray-400",
  activeNav: "text-gray-300",
  activeNavBg: "bg-gray-600/20",
  chevron: "text-gray-500",
}

const navItems = [
  { href: "/dashboard",     label: "Dashboard",         icon: LayoutDashboard },
  { href: "/prospects",     label: "Prospects",         icon: Users },
  { href: "/campaigns",     label: "Campaigns",         icon: Megaphone },
  { href: "/packs",         label: "Pack Explorer",     icon: Package },
  { href: "/activity",      label: "Live Activity",     icon: Activity },
  { href: "/costs",         label: "Costs & Models",    icon: Coins },
  { href: "/guardrails",    label: "Guardrails",        icon: ShieldCheck },
  { href: "/settings",      label: "Settings",          icon: SettingsIcon },
]

export function Sidebar() {
  const pathname = usePathname()
  const router = useRouter()
  const { isDark, toggle } = useTheme()
  const { vertical, verticalOption } = useVertical()
  const [resetting, setResetting] = useState(false)
  const [confirmReset, setConfirmReset] = useState(false)

  // Color/icon tone is vertical-specific (so users can tell which pack is
  // active at a glance); name + subtitle come from the manifest +
  // engine-wide brand.
  const branding = VERTICAL_BRANDING[vertical] ?? FALLBACK_BRANDING
  const BrandIcon = branding.icon
  const brandName = verticalOption.label
  const brandSubtitle = "Sales Engine"

  const handleReset = async () => {
    if (!confirmReset) { setConfirmReset(true); return }
    setResetting(true)
    setConfirmReset(false)
    await api.resetDemo()
    setResetting(false)
    router.push("/dashboard")
    router.refresh()
  }

  return (
    <aside className="w-60 bg-gray-900 border-r border-gray-800 flex flex-col shrink-0">
      {/* Logo — changes with vertical */}
      <div className="px-4 py-5 border-b border-gray-800">
        <div className="flex items-center gap-2.5">
          <div className={cn("w-8 h-8 rounded-lg flex items-center justify-center transition-colors", branding.bg)}>
            <BrandIcon className="w-4 h-4 text-white" />
          </div>
          <div>
            <div className="text-sm font-semibold text-white leading-tight transition-all">{brandName}</div>
            <div className={cn("text-[10px] leading-tight transition-colors", branding.subtitleColor)}>{brandSubtitle}</div>
          </div>
        </div>
      </div>

      {/* Nav */}
      <nav className="flex-1 px-3 py-3 space-y-0.5">
        {navItems.map(({ href, label, icon: Icon }) => {
          const active = pathname === href || (href !== "/" && pathname.startsWith(href + "/"))
          return (
            <Link
              key={href}
              href={href}
              className={cn(
                "flex items-center gap-2.5 px-2.5 py-2 rounded-md text-sm transition-colors",
                active
                  ? `${branding.activeNavBg} ${branding.activeNav}`
                  : "text-gray-400 hover:text-gray-100 hover:bg-gray-800/60"
              )}
            >
              <Icon className="shrink-0 w-4 h-4" />
              <span>{label}</span>
              {active && <ChevronRight className={cn("w-3 h-3 ml-auto", branding.chevron)} />}
            </Link>
          )
        })}
      </nav>

      {/* Footer */}
      <div className="px-3 py-3 border-t border-gray-800 space-y-2">
        <button
          onClick={toggle}
          className="w-full flex items-center gap-2 px-2.5 py-2 rounded-md text-xs text-gray-500 hover:text-gray-300 hover:bg-gray-800/50 transition-colors"
        >
          {isDark ? <Sun className="w-3.5 h-3.5 shrink-0" /> : <Moon className="w-3.5 h-3.5 shrink-0" />}
          {isDark ? "Light mode" : "Dark mode"}
        </button>

        <button
          onClick={handleReset}
          disabled={resetting}
          onBlur={() => setConfirmReset(false)}
          className={cn(
            "w-full flex items-center gap-2 px-2.5 py-2 rounded-md text-xs transition-all",
            confirmReset
              ? "bg-red-900/50 border border-red-700 text-red-300"
              : "text-gray-600 hover:text-gray-400 hover:bg-gray-800/50"
          )}
        >
          <RotateCcw className={cn("w-3.5 h-3.5 shrink-0", resetting && "animate-spin")} />
          {resetting ? "Resetting..." : confirmReset ? "Click again to confirm" : "Reset Demo"}
        </button>
        <div className="text-[10px] text-gray-600 leading-snug px-1">
          <div className="font-medium text-gray-500">Carla · Sales Engine</div>
          <div>Powered by Claude</div>
        </div>
      </div>
    </aside>
  )
}
