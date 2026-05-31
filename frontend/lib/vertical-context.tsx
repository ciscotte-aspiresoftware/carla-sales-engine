"use client"

import { createContext, useContext, useEffect, useState } from "react"
import { api } from "@/lib/api"
import type { VerticalManifestEntry } from "@/lib/types"

export interface VerticalOption {
  id: string
  label: string
  shortLabel: string
  color: string          // tailwind text color
  accentBg: string       // tailwind bg for active pill
  accentBorder: string
}

/** Color tokens packs can declare via `industry_context.ui.color_token`.
 * Tailwind purges unknown class names at build time, so the *full* set of
 * supported tokens has to live here as literal strings — adding a new color
 * requires editing this map once. The set of *verticals* is fully data-driven. */
const COLOR_TOKENS: Record<string, Pick<VerticalOption, "color" | "accentBg" | "accentBorder">> = {
  sky:     { color: "text-sky-400",     accentBg: "bg-sky-600/20",     accentBorder: "border-sky-700" },
  purple:  { color: "text-purple-400",  accentBg: "bg-purple-600/20",  accentBorder: "border-purple-700" },
  emerald: { color: "text-emerald-400", accentBg: "bg-emerald-600/20", accentBorder: "border-emerald-700" },
  amber:   { color: "text-amber-400",   accentBg: "bg-amber-600/20",   accentBorder: "border-amber-700" },
  rose:    { color: "text-rose-400",    accentBg: "bg-rose-600/20",    accentBorder: "border-rose-700" },
  cyan:    { color: "text-cyan-400",    accentBg: "bg-cyan-600/20",    accentBorder: "border-cyan-700" },
  violet:  { color: "text-violet-400",  accentBg: "bg-violet-600/20",  accentBorder: "border-violet-700" },
  // Fallback for packs that haven't declared a token yet
  gray:    { color: "text-gray-400",    accentBg: "bg-gray-600/20",    accentBorder: "border-gray-700" },
}

function manifestEntryToOption(e: VerticalManifestEntry): VerticalOption {
  const tone = COLOR_TOKENS[e.color_token ?? "gray"] ?? COLOR_TOKENS.gray
  return {
    id: e.id,
    label: e.label,
    shortLabel: e.label,
    ...tone,
  }
}

interface VerticalContextType {
  vertical: string
  setVertical: (v: string) => void
  verticalOption: VerticalOption
  /** All verticals the backend currently knows about. Empty until the manifest
   * fetch resolves. UI code should handle the empty case gracefully. */
  availableVerticals: VerticalOption[]
}

const FALLBACK_OPTION: VerticalOption = {
  id: "car_rental",
  label: "Car Rental",
  shortLabel: "Car Rental",
  ...COLOR_TOKENS.violet,
}

const DEFAULT: VerticalContextType = {
  vertical: "car_rental",
  setVertical: () => {},
  verticalOption: FALLBACK_OPTION,
  availableVerticals: [],
}

const VerticalContext = createContext<VerticalContextType>(DEFAULT)

export function VerticalProvider({ children }: { children: React.ReactNode }) {
  const [available, setAvailable] = useState<VerticalOption[]>([])
  const [vertical, setVerticalState] = useState("car_rental")

  // Boot: fetch manifest, then hydrate the active vertical from localStorage.
  // localStorage migration: if the legacy "aspire_vertical" key is present,
  // copy it to the new "sdr_engine_vertical" key once.
  useEffect(() => {
    let cancelled = false
    api.getVerticalsManifest().then((res) => {
      if (cancelled) return
      const opts = (res.verticals || []).map(manifestEntryToOption)
      setAvailable(opts)

      const legacy = localStorage.getItem("aspire_vertical")
      if (legacy && !localStorage.getItem("sdr_engine_vertical")) {
        localStorage.setItem("sdr_engine_vertical", legacy)
        localStorage.removeItem("aspire_vertical")
      }
      const stored = localStorage.getItem("sdr_engine_vertical")
      if (stored && opts.some((o) => o.id === stored)) {
        setVerticalState(stored)
      } else if (opts.length > 0) {
        // Fall back to the first vertical the backend declared, not a hardcoded one
        setVerticalState(opts[0].id)
      }
    }).catch(() => {
      // If the manifest fetch fails (e.g. backend offline), leave defaults.
      // UI should still render with the fallback marina option.
    })
    return () => { cancelled = true }
  }, [])

  const setVertical = (v: string) => {
    setVerticalState(v)
    localStorage.setItem("sdr_engine_vertical", v)
  }

  const verticalOption = available.find((v) => v.id === vertical) ?? FALLBACK_OPTION

  return (
    <VerticalContext.Provider value={{ vertical, setVertical, verticalOption, availableVerticals: available }}>
      {children}
    </VerticalContext.Provider>
  )
}

export const useVertical = () => useContext(VerticalContext)
