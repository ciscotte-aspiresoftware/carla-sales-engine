import { IconMail, IconPhone, IconBrandLinkedin } from '@tabler/icons-react'
import { CopyEmail } from '@/components/ui/copy-email'
import type { ScrapedContacts } from '@/lib/api'

// Contacts harvested from a company's scraped website (emails / phones /
// LinkedIn). Shared by the Database drawer and the Accounts detail view so
// both render identically. Renders nothing when there are no contacts.
export function ScrapedContactsBlock({ contacts }: { contacts?: ScrapedContacts | null }) {
  if (!contacts) return null
  const { emails = [], phones = [], linkedinPersonUrls = [], linkedinCompanyUrls = [] } = contacts
  const liUrls = [...linkedinCompanyUrls, ...linkedinPersonUrls]
  if (emails.length === 0 && phones.length === 0 && liUrls.length === 0) return null
  return (
    <div>
      <div className="text-[10px] uppercase tracking-wider text-muted-foreground mb-2">
        Scraped from website
      </div>
      <div className="flex flex-col gap-2">
        {emails.length > 0 && (
          <div className="flex items-start gap-2">
            <IconMail className="h-3.5 w-3.5 mt-0.5 shrink-0 text-sky-600 dark:text-sky-400" />
            <div className="flex flex-wrap gap-1.5">
              {emails.map((e) => (
                <CopyEmail key={e} email={e} className="px-1.5 py-0.5 rounded bg-sky-500/10 text-sky-700 dark:text-sky-300" />
              ))}
            </div>
          </div>
        )}
        {phones.length > 0 && (
          <div className="flex items-start gap-2">
            <IconPhone className="h-3.5 w-3.5 mt-0.5 shrink-0 text-emerald-600 dark:text-emerald-400" />
            <div className="flex flex-wrap gap-1.5">
              {phones.map((p) => (
                <a key={p} href={`tel:${p.replace(/\s+/g, '')}`} className="px-1.5 py-0.5 rounded bg-emerald-500/10 text-emerald-700 dark:text-emerald-300 hover:underline">{p}</a>
              ))}
            </div>
          </div>
        )}
        {liUrls.length > 0 && (
          <div className="flex items-start gap-2">
            <IconBrandLinkedin className="h-3.5 w-3.5 mt-0.5 shrink-0 text-blue-600 dark:text-blue-400" />
            <div className="flex flex-wrap gap-1.5">
              {liUrls.map((u) => {
                const isCompany = u.includes('/company/')
                const handle = u.replace(/\/+$/, '').split('/').pop() || u
                return (
                  <a key={u} href={u} target="_blank" rel="noreferrer" className="px-1.5 py-0.5 rounded bg-blue-500/10 text-blue-700 dark:text-blue-300 hover:underline" title={u}>
                    {isCompany ? 'company: ' : 'in: '}{handle}
                  </a>
                )
              })}
            </div>
          </div>
        )}
      </div>
    </div>
  )
}