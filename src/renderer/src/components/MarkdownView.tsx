import { useMemo } from 'react'
import ReactMarkdown, { defaultUrlTransform } from 'react-markdown'
import remarkGfm from 'remark-gfm'

/** Sentinel protocol `preprocessObsidian` puts on a wikilink's href. */
const WIKILINK = 'wikilink:'

/**
 * Obsidian-style markdown rendering. We pre-process two Obsidian constructs that
 * standard GFM doesn't cover — wikilinks [[Note]] and callouts (> [!note]) —
 * then hand the rest to react-markdown + remark-gfm.
 */
export function MarkdownView({ source }: { source: string }): JSX.Element {
  return (
    <div className="markdown">
      <MarkdownBody source={source} />
    </div>
  )
}

/**
 * The rendered markdown without the `.markdown` wrapper, so a caller can place
 * several of them inside one wrapper. react-markdown renders into a fragment, so
 * the pieces still land as direct children of that single wrapper and CSS that
 * targets `.markdown > *` behaves exactly as with one big render.
 */
export function MarkdownBody({ source }: { source: string }): JSX.Element {
  const processed = useMemo(() => preprocessObsidian(source), [source])
  return (
    <ReactMarkdown
      remarkPlugins={[remarkGfm]}
      urlTransform={keepWikilinks}
      components={{
        // Render wikilink spans we injected as HTML-ish markers. `node` is
        // react-markdown's mdast node — drop it so it can't reach the DOM.
        a({ href, children, node: _node, ...props }) {
          if (href?.startsWith(WIKILINK)) {
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
  )
}

/**
 * react-markdown blanks out hrefs whose protocol it doesn't recognise, which
 * would erase our sentinel before the `a` override ever sees it. Wave the
 * sentinel through and leave every other URL to the default transform, so its
 * filtering of `javascript:` and friends still applies.
 */
function keepWikilinks(url: string): string {
  return url.startsWith(WIKILINK) ? url : defaultUrlTransform(url)
}

function preprocessObsidian(src: string): string {
  let out = src

  // Wikilinks: [[Target|Alias]] or [[Target]] -> markdown link with sentinel href.
  out = out.replace(/\[\[([^\]|]+)(?:\|([^\]]+))?\]\]/g, (_m, target: string, alias?: string) => {
    const label = (alias ?? target).trim()
    return `[${label}](${WIKILINK}${encodeURIComponent(target.trim())})`
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
