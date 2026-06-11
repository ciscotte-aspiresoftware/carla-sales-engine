// Lightweight sidebar collapse state. Persisted to localStorage so the
// preference sticks across reloads. We deliberately don't use the full
// shadcn Sidebar primitive (which is ~770 lines + a Sheet dependency for
// mobile) - for a 2-page demo, a width-toggle + label-hide is plenty.

import { createContext, useContext, useEffect, useState } from 'react'

type SidebarState = {
  collapsed: boolean
  toggle: () => void
  setCollapsed: (v: boolean) => void
}

const SidebarContext = createContext<SidebarState>({
  collapsed: false,
  toggle: () => {},
  setCollapsed: () => {},
})

const STORAGE_KEY = 'carla-sidebar-collapsed'

export function SidebarProvider({ children }: { children: React.ReactNode }) {
  const [collapsed, _setCollapsed] = useState<boolean>(() => {
    return localStorage.getItem(STORAGE_KEY) === '1'
  })

  useEffect(() => {
    localStorage.setItem(STORAGE_KEY, collapsed ? '1' : '0')
  }, [collapsed])

  const setCollapsed = (v: boolean) => _setCollapsed(v)
  const toggle = () => _setCollapsed((c) => !c)

  return (
    <SidebarContext.Provider value={{ collapsed, toggle, setCollapsed }}>
      {children}
    </SidebarContext.Provider>
  )
}

// eslint-disable-next-line react-refresh/only-export-components
export const useSidebar = () => useContext(SidebarContext)
