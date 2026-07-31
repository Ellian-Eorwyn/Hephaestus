/**
 * Remark plugin: turn bare file paths in prose into links.
 *
 * Rewriting them into mdast `link` nodes with a sentinel protocol (rather than
 * post-processing rendered React children) means every reference form — an explicit
 * markdown link, a path in prose — arrives at the same `a` renderer, so there is one
 * place that decides what a file link looks like.
 *
 * Only text nodes are visited, and never inside an existing link or code span, so a
 * path already written as a link isn't rewritten twice.
 */
import type { LinkContext } from './filelinks'
import { pathScanner, resolveGuess } from './filelinks'

/** Protocol marking an href this plugin produced. */
export const FILE_SENTINEL = 'hephfile:'

interface MdNode {
  type: string
  value?: string
  url?: string
  children?: MdNode[]
}

/**
 * Unified attacher. Used in the tuple form — `[remarkFilePaths, ctx]` — so unified
 * calls it with the context and gets the transformer back.
 */
export function remarkFilePaths(ctx: LinkContext) {
  return function transformer(tree: MdNode): void {
    // Nothing listed yet (no project open) means nothing can be validated, so skip
    // the walk entirely rather than scanning every message for no possible hit.
    if (!ctx || ctx.known.size === 0) return
    visit(tree)
  }

  function visit(node: MdNode): void {
    if (!node.children) return
    // Inside a link the text is already the label; inline code is handled by its
    // own renderer, which can style the result as code.
    if (node.type === 'link' || node.type === 'linkReference' || node.type === 'inlineCode') return

    const next: MdNode[] = []
    let replaced = false
    for (const child of node.children) {
      if (child.type === 'text' && typeof child.value === 'string') {
        const split = splitTextNode(child.value)
        if (split) {
          next.push(...split)
          replaced = true
          continue
        }
      }
      visit(child)
      next.push(child)
    }
    if (replaced) node.children = next
  }

  function splitTextNode(value: string): MdNode[] | null {
    const re = pathScanner()
    const out: MdNode[] = []
    let last = 0
    let m: RegExpExecArray | null
    while ((m = re.exec(value))) {
      const ref = resolveGuess(m[0], ctx)
      if (!ref) continue
      if (m.index > last) out.push({ type: 'text', value: value.slice(last, m.index) })
      out.push({
        type: 'link',
        url: `${FILE_SENTINEL}${encodeURIComponent(m[0])}`,
        children: [{ type: 'text', value: m[0] }]
      })
      last = m.index + m[0].length
    }
    if (!out.length) return null
    if (last < value.length) out.push({ type: 'text', value: value.slice(last) })
    return out
  }
}
