import { useMemo } from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'

/**
 * Obsidian-style markdown rendering. We pre-process two Obsidian constructs that
 * standard GFM doesn't cover — wikilinks [[Note]] and callouts (> [!note]) —
 * then hand the rest to react-markdown + remark-gfm.
 */
export function MarkdownView({ source }: { source: string }): JSX.Element {
  const processed = useMemo(() => preprocessObsidian(source), [source])
  return (
    <div className="markdown">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          // Render wikilink spans we injected as HTML-ish markers.
          a({ href, children, ...props }) {
            if (href?.startsWith('wikilink:')) {
              return <span className="wikilink">{children}</span>
            }
            return (
              <a href={href} {...props} onClick={(e) => e.preventDefault()}>
                {children}
              </a>
            )
          }
        }}
      >
        {processed}
      </ReactMarkdown>
    </div>
  )
}

function preprocessObsidian(src: string): string {
  let out = src

  // Wikilinks: [[Target|Alias]] or [[Target]] -> markdown link with sentinel href.
  out = out.replace(/\[\[([^\]|]+)(?:\|([^\]]+))?\]\]/g, (_m, target: string, alias?: string) => {
    const label = (alias ?? target).trim()
    return `[${label}](wikilink:${encodeURIComponent(target.trim())})`
  })

  // Callouts: convert "> [!type] Title" blocks into a blockquote with a marker.
  // We keep it simple: rewrite the first callout line so the type shows as bold.
  out = out.replace(/^>\s*\[!(\w+)\]\s*(.*)$/gim, (_m, type: string, title: string) => {
    const heading = title.trim() || capitalize(type)
    return `> **${capitalize(type)}** — ${heading}`
  })

  return out
}

function capitalize(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1)
}
