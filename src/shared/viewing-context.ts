// Helpers for the directive block Hephaestus prepends to a user message.
//
// The pi RPC protocol has no system-prompt channel — `{type:'prompt', message}` is
// the only thing we get to write — so anything the agent needs to know about the UI
// it is talking through rides on the message itself. Two directives live here:
//
//   * the file the user is looking at, so "this file" resolves without being told;
//   * how to name files, so the paths it writes come back as links the user can click.
//
// The block is prepended to the message we SEND; the UI strips it back out (via
// parseViewingContext) so the chat bubble shows only the human text plus an
// attachment chip. Because the harness persists the wrapped message to the session
// JSONL, the parser must round-trip its own format *and* the one 0.2.1 wrote.

export const VIEWING_CONTEXT_TAG = 'viewing-context'

/**
 * Told to the agent when file-link guidance is on.
 *
 * Written in the positive throughout — a small local model follows "do this" far
 * better than "don't do that" — and it asks for backticks specifically, because a
 * backticked path routes through the strongest resolver in the renderer and needs no
 * pattern match against the surrounding prose to be recognised.
 */
const FILE_LINK_DIRECTIVE =
  'File paths: whenever you name a file, write its path from the project root inside ' +
  'backticks, like `src/main/index.ts`. When you mean a specific line, append it: ' +
  '`src/main/index.ts:42`. Do this every time you mention a file — in prose, in lists, ' +
  'and in summaries. Hephaestus renders these as links the user clicks to open the file.'

/** Told to the agent when a file is open in the preview pane. */
function viewingDirective(filePath: string): string {
  return (
    `The user is currently viewing this file in the Hephaestus preview pane:\n${filePath}\n` +
    `If they refer to "this file", "this", "here", "above", or mention a section, symbol, ` +
    `function, or name without specifying a file, assume they mean this file and read it ` +
    `with your tools as needed.`
  )
}

/**
 * Prepend the directive block to a user message. Returns the text untouched when
 * there is nothing to say, so an ordinary message stays an ordinary message.
 *
 * The `file` attribute stays first and is emitted only when there is a file, so the
 * pattern below still matches every block written before this change byte for byte.
 */
export function wrapWithContext(
  text: string,
  opts: { file?: string | null; fileLinks?: boolean }
): string {
  const directives: string[] = []
  if (opts.file) directives.push(viewingDirective(opts.file))
  if (opts.fileLinks) directives.push(FILE_LINK_DIRECTIVE)
  if (directives.length === 0) return text

  const attr = opts.file ? ` file="${opts.file}"` : ''
  const body = directives.join('\n\n')
  return `<${VIEWING_CONTEXT_TAG}${attr}>\n${body}\n</${VIEWING_CONTEXT_TAG}>\n\n${text}`
}

// `file` is optional: 0.2.1 always wrote it, and the block now also appears without
// one. A non-participating group yields `undefined`, so both callers are unchanged.
const RE = new RegExp(
  `^<${VIEWING_CONTEXT_TAG}(?: file="([^"]*)")?>[\\s\\S]*?</${VIEWING_CONTEXT_TAG}>\\n*`
)

/**
 * Strip a leading directive block, returning the attached file path (if any) and the
 * remaining human text. Safe to call on any user message.
 */
export function parseViewingContext(raw: string): { file?: string; text: string } {
  const m = raw.match(RE)
  if (!m) return { text: raw }
  return { file: m[1] || undefined, text: raw.slice(m[0].length) }
}
