import type { ReactNode } from 'react'
import { cn } from '@/lib/utils'

// Minimal markdown renderer for GPT-generated company reports. Handles the
// subset our report prompts emit: headings (#–####), **bold**, bullet and
// numbered lists, and paragraphs. Builds React nodes directly (no
// dangerouslySetInnerHTML) so it's XSS-safe by construction. Not a full
// CommonMark implementation - if reports ever need tables/links/images,
// swap in react-markdown.

function renderInline(text: string): ReactNode[] {
  // Split on **bold** spans; everything else renders as plain text.
  const parts = text.split(/(\*\*[^*]+\*\*)/g)
  return parts.map((p, i) => {
    const m = p.match(/^\*\*([^*]+)\*\*$/)
    if (m) return <strong key={i}>{m[1]}</strong>
    return <span key={i}>{p}</span>
  })
}

export function Markdown({ source, className }: { source: string; className?: string }) {
  const lines = (source || '').replace(/\r\n/g, '\n').split('\n')
  const blocks: ReactNode[] = []
  let listBuf: { ordered: boolean; items: string[] } | null = null
  let paraBuf: string[] = []
  let key = 0

  const flushPara = () => {
    if (paraBuf.length) {
      blocks.push(
        <p key={key++} className="text-xs leading-relaxed mb-2">{renderInline(paraBuf.join(' '))}</p>,
      )
      paraBuf = []
    }
  }
  const flushList = () => {
    if (listBuf) {
      const items = listBuf.items.map((it, i) => <li key={i}>{renderInline(it)}</li>)
      blocks.push(
        listBuf.ordered
          ? <ol key={key++} className="list-decimal list-inside text-xs space-y-0.5 mb-2">{items}</ol>
          : <ul key={key++} className="list-disc list-inside text-xs space-y-0.5 mb-2">{items}</ul>,
      )
      listBuf = null
    }
  }

  for (const raw of lines) {
    const line = raw.trimEnd()
    if (!line.trim()) { flushPara(); flushList(); continue }

    const h = line.match(/^(#{1,4})\s+(.*)$/)
    if (h) {
      flushPara(); flushList()
      const level = h[1].length
      const cls =
        level <= 1 ? 'text-sm font-bold mt-3 mb-1'
        : level === 2 ? 'text-[10px] font-bold uppercase tracking-wider text-muted-foreground mt-3 mb-1'
        : 'text-xs font-semibold mt-2 mb-1'
      blocks.push(<div key={key++} className={cls}>{renderInline(h[2])}</div>)
      continue
    }

    const ul = line.match(/^\s*[-*]\s+(.*)$/)
    if (ul) {
      flushPara()
      if (!listBuf || listBuf.ordered) { flushList(); listBuf = { ordered: false, items: [] } }
      listBuf.items.push(ul[1])
      continue
    }

    const ol = line.match(/^\s*\d+[.)]\s+(.*)$/)
    if (ol) {
      flushPara()
      if (!listBuf || !listBuf.ordered) { flushList(); listBuf = { ordered: true, items: [] } }
      listBuf.items.push(ol[1])
      continue
    }

    flushList()
    paraBuf.push(line.trim())
  }
  flushPara(); flushList()

  return <div className={cn(className)}>{blocks}</div>
}