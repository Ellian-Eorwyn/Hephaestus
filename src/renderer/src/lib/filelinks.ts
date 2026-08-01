/**
 * Turning file references in an agent's reply into things you can click.
 *
 * Agents name files in four ways, and all four are supported:
 *   1. a markdown link — `[src/main/index.ts](src/main/index.ts)`
 *   2. inline code — `` `src/main/index.ts` ``
 *   3. bare prose — "the watcher lives in src/main/file-service.ts"
 *   4. a tool call's `path` argument
 *
 * (1) is explicit, so it only has to resolve inside the project. (2) and (3) are
 * guesses, so they are additionally required to match a path we actually listed —
 * validating against the real tree is what keeps ordinary prose from sprouting
 * underlines. Nothing here ever touches the filesystem; it is all string work
 * against the tree the inspector already holds.
 */
import { isInside, resolveProjectPath, splitLineSuffix } from '@shared/paths'

/** What a recognised reference resolves to. */
export interface FileRef {
  /** Absolute path on disk. */
  path: string
  /** 1-based line, when the reference carried one. */
  line?: number
  /**
   * Set when the path lands inside the project but matches nothing we have listed.
   * Still worth linking — the agent may be naming a file it created moments ago —
   * but the UI shouldn't promise it opens.
   */
  unverified?: true
}

export interface LinkContext {
  cwd: string | null
  home: string
  /** Absolute paths of everything we know about in the project. */
  known: Set<string>
  /**
   * Bare filename -> its one path in the project. Only unambiguous names appear:
   * agents routinely write just `web-research.mjs` for a file several folders deep,
   * and that is worth resolving — but never by picking one of several candidates.
   */
  byBasename: Map<string, string>
}

/**
 * Path-shaped enough to be worth checking against the tree.
 *
 * Requires either a directory separator or a file extension, so bare words and
 * ordinary sentences never qualify. Trailing sentence punctuation is left off the
 * match so "see src/App.tsx." doesn't swallow the full stop.
 */
const PATH_RE =
  /(?:~\/|\.{0,2}\/)?(?:[\w.@+-]+\/)*[\w.@+-]+\.[A-Za-z0-9]{1,12}(?::\d+(?::\d+)?|#L\d+)?|(?:~\/|\.{0,2}\/)(?:[\w.@+-]+\/)*[\w.@+-]+/

/** Global variant for scanning prose. */
export function pathScanner(): RegExp {
  return new RegExp(PATH_RE.source, 'g')
}

/**
 * Resolve an explicit reference (a markdown href or a tool-call `path`). Accepted
 * whenever it lands inside the project, whether or not it has been listed — the
 * agent may well be linking a file it just created.
 */
export function resolveExplicit(raw: string, ctx: LinkContext): FileRef | null {
  // A `file:///abs/path` href is a path wearing a scheme, and `resolveProjectPath`
  // refuses anything with one. Models that know links exist write this form often
  // enough that rejecting it throws away a whole class of correct references.
  const { path: bare, line } = splitLineSuffix(raw.trim().replace(/^file:\/\//, ''))
  if (!bare) return null
  const abs = resolveProjectPath(ctx.cwd, bare, ctx.home)
  if (abs && ctx.known.has(abs)) return { path: abs, line }

  // A bare filename resolves the same way in an href as it does in prose.
  // `[Forge.tsx](Forge.tsx)` is a shape agents write constantly, and joining it onto
  // the project root yields a file that has never existed — dead links, every time.
  if (!bare.includes('/')) {
    const unique = ctx.byBasename.get(bare)
    if (unique) return { path: unique, line }
  }
  if (abs && ctx.cwd && isInside(ctx.cwd, abs)) return { path: abs, line, unverified: true }
  return null
}

/**
 * Resolve a guessed reference (inline code, or a path spotted in prose). Stricter:
 * it must be a path we have actually listed.
 */
export function resolveGuess(raw: string, ctx: LinkContext): FileRef | null {
  const trimmed = raw.trim()
  if (!trimmed || /\s/.test(trimmed)) return null
  if (!looksLikePath(trimmed)) return null
  const { path: bare, line } = splitLineSuffix(trimmed)
  const abs = resolveProjectPath(ctx.cwd, bare, ctx.home)
  if (abs && ctx.known.has(abs)) return { path: abs, line }

  // A bare filename with no directory part: accept it only when the project holds
  // exactly one file by that name.
  if (!bare.includes('/')) {
    const unique = ctx.byBasename.get(bare)
    if (unique) return { path: unique, line }
  }
  return null
}

/**
 * Resolve a backticked reference.
 *
 * Backticks bound the reference exactly, so none of the shape rules prose needs
 * apply here: matching the project's real contents is a far stronger test than any
 * pattern, and it is the only one that admits the filenames people actually have.
 * `08 Directory/8.01 People — Contacts/Gillian Eorwyn.md` is an unremarkable note in
 * an Obsidian vault — spaces, an em dash, a numbered folder — and no path-shaped
 * regex will ever match it. Neither will `Makefile` or `.gitignore`, which carry no
 * separator and no extension at all.
 *
 * Nothing is lost by dropping the shape test: a backticked `npm run dev` resolves to
 * a path nobody has, so it stays code. Prose keeps the strict rule, where the
 * reference has no delimiters and a lone word is far more likely to be a word.
 */
export function resolveInlineCode(raw: string, ctx: LinkContext): FileRef | null {
  const trimmed = raw.trim()
  if (!trimmed) return null
  const { path: bare, line } = splitLineSuffix(trimmed)
  const abs = resolveProjectPath(ctx.cwd, bare, ctx.home)
  if (abs && ctx.known.has(abs)) return { path: abs, line }
  if (!bare.includes('/')) {
    const unique = ctx.byBasename.get(bare)
    if (unique) return { path: unique, line }
  }
  return null
}

/**
 * Resolve an Obsidian `[[wikilink]]` to a note.
 *
 * In a vault this is *the* way to name a note, so leaving it inert meant the one
 * reference form the user's own notes are built from was the one that didn't work. A
 * target names a note rather than a path — usually without the `.md` — and may carry
 * a `#heading` this pane has no way to jump to, so the fragment is dropped.
 */
export function resolveWikilink(target: string, ctx: LinkContext): FileRef | null {
  const name = target.split('#')[0].trim()
  if (!name) return null
  for (const candidate of name.endsWith('.md') ? [name] : [`${name}.md`, name]) {
    const abs = resolveProjectPath(ctx.cwd, candidate, ctx.home)
    if (abs && ctx.known.has(abs)) return { path: abs }
    if (!candidate.includes('/')) {
      const unique = ctx.byBasename.get(candidate)
      if (unique) return { path: unique }
    }
  }
  return null
}

/** Cheap shape test used before the (more expensive) tree lookup. */
export function looksLikePath(s: string): boolean {
  const m = new RegExp(`^(?:${PATH_RE.source})$`).exec(s)
  return !!m
}
