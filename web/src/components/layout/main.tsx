import * as React from 'react'
import { cn } from '@/lib/utils'

export function Main({ className, ...props }: React.HTMLAttributes<HTMLElement>) {
  return (
    <main
      className={cn('flex-1 overflow-auto px-6 py-6 md:px-8 md:py-8', className)}
      {...props}
    />
  )
}
