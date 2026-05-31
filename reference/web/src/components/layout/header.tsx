import * as React from 'react'
import { cn } from '@/lib/utils'

interface HeaderProps extends React.HTMLAttributes<HTMLElement> {}

export function Header({ className, children, ...props }: HeaderProps) {
  return (
    <header
      className={cn(
        // Glass header - same translucency as the sidebar so the photo
        // backdrop continues across the top of the page. The override
        // className from App.tsx can replace the bg if it wants.
        'sticky top-0 z-10 flex h-14 items-center gap-3 px-6 border-b border-white/30 dark:border-white/10 bg-white/30 dark:bg-white/[0.04] backdrop-blur-xl',
        className
      )}
      {...props}
    >
      {children}
    </header>
  )
}
