import { IconMail, IconPhone, IconBrandLinkedin, IconLoader2 } from '@tabler/icons-react'
import { cn } from '@/lib/utils'

interface LeadStatusBadgesProps {
  email?: string | null
  phone?: string | null
  linkedinUrl?: string | null
  phoneChecking?: boolean
  className?: string
}

export function LeadStatusBadges({
  email,
  phone,
  linkedinUrl,
  phoneChecking,
  className,
}: LeadStatusBadgesProps) {
  const hasEmail = !!email
  const hasPhone = !!phone
  const hasLinkedin = !!linkedinUrl

  return (
    <div className={cn('flex items-center gap-1.5', className)}>
      {/* Email */}
      <div
        className={cn(
          'p-1 rounded',
          hasEmail ? 'bg-emerald-500/20 text-emerald-600' : 'bg-gray-200 text-gray-400'
        )}
        title={hasEmail ? `Email: ${email}` : 'No email'}
      >
        <IconMail className="w-3.5 h-3.5" />
      </div>

      {/* Phone */}
      <div
        className={cn(
          'p-1 rounded transition-all',
          phoneChecking
            ? 'bg-amber-500/20 text-amber-600 animate-pulse'
            : hasPhone
              ? 'bg-emerald-500/20 text-emerald-600'
              : 'bg-gray-200 text-gray-400 hover:bg-gray-300 cursor-default'
        )}
        title={
          phoneChecking
            ? 'Revealing phone...'
            : hasPhone
              ? `Phone: ${phone}`
              : 'No phone yet'
        }
      >
        {phoneChecking ? (
          <IconLoader2 className="w-3.5 h-3.5 animate-spin" />
        ) : (
          <IconPhone className="w-3.5 h-3.5" />
        )}
      </div>

      {/* LinkedIn */}
      <div
        className={cn(
          'p-1 rounded',
          hasLinkedin ? 'bg-emerald-500/20 text-emerald-600' : 'bg-gray-200 text-gray-400'
        )}
        title={hasLinkedin ? 'LinkedIn profile cached' : 'No LinkedIn data'}
      >
        <IconBrandLinkedin className="w-3.5 h-3.5" />
      </div>
    </div>
  )
}
