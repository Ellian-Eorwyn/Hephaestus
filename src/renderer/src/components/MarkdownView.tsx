import { useMemo } from 'react'
import ReactMarkdown, { defaultUrlTransform } from 'react-markdown'
import type { PluggableList } from 'unified'
import remarkGfm from 'remark-gfm'
import { resolveExplicit, resolveGuess } from '../lib/filelinks'
import { FILE_SENTINEL, remarkFilePaths } from '../lib/remark-file-paths'
import { FileLink, useLinkContext } from './FileLink'

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
  const linkCtx = useLinkContext()
  // Memoized on the link context, not per render: a new plugin array on every
  // frame would defeat the per-block memoization that keeps a long streamed reply
  // from re-parsing itself on each token.
  const plugins: PluggableList = useMemo(() => [remarkGfm, [remarkFilePaths, linkCtx]], [linkCtx])

  return (
    <ReactMarkdown
      remarkPlugins={plugins}
      urlTransform={keepSentinels}
      components={{
        // Render wikilink spans we injected as HTML-ish markers. `node` is
        // react-markdown's mdast node — drop it so it can't reach the DOM.
        a({ href, children, node: _node, ...props }) {
          if (href?.startsWith(WIKILINK)) {
            return <span className="wikilink">{children}</span>
          }
          // A path we spotted in prose, or a link the agent wrote pointing at a
          // file in this project: clicking opens it in the preview pane.
          const raw = href?.startsWith(FILE_SENTINEL)
            ? decodeURIComponent(href.slice(FILE_SENTINEL.length))
            : href
          const ref = raw ? resolveExplicit(raw, linkCtx) : null
          if (ref) {
            return <FileLink path={ref.path} line={ref.line} label={nodeText(children) ?? undefined} />
          }
          return (
            <a href={href} {...props} onClick={(e) => e.preventDefault()}>
              {children}
            </a>
          )
        },
        // Backticked paths are how agents most often name a file. Only ones that
        // match something actually listed in the tree become links, so ordinary
        // inline code is left alone.
        code({ className, children, node: _node, ...props }) {
          const text = nodeText(children)
          if (text && !className) {
            const ref = resolveGuess(text, linkCtx)
            if (ref) {
              return <FileLink path={ref.path} line={ref.line} label={text} variant="code" />
            }
          }
          return (
            <code className={className} {...props}>
              {children}
            </code>
          )
        }
      }}
    >
      {processed}
    </ReactMarkdown>
  )
}

/**
 * Plain text of a rendered child, when it is plain text. react-markdown hands
 * children through as a string for a simple span but as an array once anything
 * else is nested, and only the former can be a file reference.
 */
function nodeText(children: React.ReactNode): string | null {
  if (typeof children === 'string') return children
  if (Array.isArray(children) && children.length === 1 && typeof children[0] === 'string') {
    return children[0]
  }
  return null
}

/**
 * react-markdown blanks out hrefs whose protocol it doesn't recognise, which
 * would erase our sentinels before the `a` override ever sees them. Wave those
 * through and leave every other URL to the default transform, so its filtering of
 * `javascript:` and friends still applies.
 */
function keepSentinels(url: string): string {
  if (url.startsWith(WIKILINK) || url.startsWith(FILE_SENTINEL)) return url
  return defaultUrlTransform(url)
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
