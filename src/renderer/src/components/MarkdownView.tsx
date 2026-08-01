import { useMemo } from 'react'
import ReactMarkdown, { defaultUrlTransform } from 'react-markdown'
import type { PluggableList } from 'unified'
import remarkGfm from 'remark-gfm'
import { resolveExplicit, resolveInlineCode, resolveWikilink } from '../lib/filelinks'
import { FILE_SENTINEL, parseFileSentinel, remarkFilePaths } from '../lib/remark-file-paths'
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
            // A wikilink naming a note in this vault opens it, like any other file
            // reference. One that resolves to nothing stays styled as a wikilink —
            // in Obsidian that's a note you haven't written yet, not a broken link.
            const note = resolveWikilink(decodeURIComponent(href.slice(WIKILINK.length)), linkCtx)
            if (note) {
              return <FileLink path={note.path} label={nodeText(children) ?? undefined} />
            }
            return <span className="wikilink">{children}</span>
          }
          // A path we spotted in prose, or a link the agent wrote pointing at a
          // file in this project: clicking opens it in the preview pane. A sentinel
          // href was resolved by the remark plugin and is taken as-is — re-resolving
          // it here would lose a `byBasename` hit the plugin had already made.
          const ref = href?.startsWith(FILE_SENTINEL)
            ? parseFileSentinel(href)
            : href
              ? resolveExplicit(href, linkCtx)
              : null
          if (ref) {
            return (
              <FileLink
                path={ref.path}
                line={ref.line}
                unverified={ref.unverified}
                label={nodeText(children) ?? undefined}
              />
            )
          }
          // Not a file: a web link opens in the real browser, and anything else
          // stays inert. Navigating the renderer itself is never right — it would
          // replace the app with the page.
          const web = isWebUrl(href)
          return (
            <a
              href={href}
              {...props}
              // The label is the agent's to choose and need not match where the link
              // goes, so the real destination is always one hover away.
              title={web ? href : undefined}
              className={web ? undefined : 'inert'}
              onClick={(e) => {
                e.preventDefault()
                if (web && href) void window.heph.openExternal(href)
              }}
            >
              {children}
            </a>
          )
        },
        // Backticked paths are how agents most often name a file. Only ones that
        // match something actually listed in the tree become links, so ordinary
        // inline code is left alone.
        code({ className, children, node: _node, ...props }) {
          const text = nodeText(children)
          // A fence with no info string reaches this renderer without a className
          // too, and its body is a whole code block — never a reference, however
          // path-shaped a one-line body might look.
          if (text && !className && !text.includes('\n')) {
            const ref = resolveInlineCode(text, linkCtx)
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
 * True for a link `openExternal` will actually accept. Deliberately no base URL: a
 * relative href resolved against the renderer's own location would turn an
 * unrecognised path into a `localhost` link and open the dev server in a browser.
 */
function isWebUrl(href: string | undefined): boolean {
  if (!href) return false
  try {
    const { protocol } = new URL(href)
    return protocol === 'http:' || protocol === 'https:'
  } catch {
    return false
  }
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
