"use client"

import { Briefcase, Car } from "lucide-react"
import { cn } from "@/lib/utils"
import { useVertical } from "@/lib/vertical-context"

/** Per-vertical icon. Falls back to Briefcase for any vertical the engine
 * doesn't have a hand-picked icon for — packs ship as JSON, so adding a new
 * vertical doesn't ship a new icon mapping unless you want one. */
const ICONS: Record<string, React.ElementType> = {
  car_rental: Car,
}
const FALLBACK_ICON = Briefcase

export function VerticalSwitcher() {
  const { vertical, setVertical, availableVerticals } = useVertical()
  if (availableVerticals.length === 0) return null
  return (
    <div className="flex gap-0.5 p-0.5 bg-gray-800/80 rounded-lg border border-gray-700/50">
      {availableVerticals.map((v) => {
        const Icon = ICONS[v.id] ?? FALLBACK_ICON
        const active = vertical === v.id
        return (
          <button
            key={v.id}
            onClick={() => setVertical(v.id)}
            className={cn(
              "flex items-center gap-1.5 px-2.5 py-1.5 rounded-md text-xs font-medium transition-all",
              active
                ? `${v.accentBg} ${v.color} border ${v.accentBorder}`
                : "text-gray-500 hover:text-gray-300"
            )}
          >
            <Icon className="w-3 h-3 shrink-0" />
            {v.shortLabel}
          </button>
        )
      })}
    </div>
  )
}
