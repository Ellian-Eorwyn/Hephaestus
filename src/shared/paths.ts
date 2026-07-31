// POSIX path helpers usable from the renderer, which has no `node:path`.
//
// Both the agent's tool stream and its prose name files in whatever form it likes —
// absolute, project-relative, `./`-prefixed, with a `:42` line suffix. These turn
// that into one absolute path so the tree, the preview and the edit-flash all agree
// on what a given reference points at.

/** Strip trailing slashes (but never reduce "/" to ""). */
export function trimTrailingSlash(p: string): string {
  const out = p.replace(/\/+$/, '')
  return out || '/'
}

/**
 * Resolve a file reference against a project directory.
 *
 * Handles absolute paths, `~`, `./`, and `..` segments. Returns null for anything
 * that can't be a path (a URL, an empty string).
 */
export function resolveProjectPath(cwd: string | null, raw: string, home?: string): string | null {
  const ref = raw.trim()
  if (!ref) return null
  if (/^[a-z][a-z0-9+.-]*:/i.test(ref)) return null // has a scheme: URL, not a path

  let joined: string
  if (ref.startsWith('/')) {
    joined = ref
  } else if (ref.startsWith('~/') || ref === '~') {
    if (!home) return null
    joined = `${trimTrailingSlash(home)}/${ref.slice(2)}`
  } else {
    if (!cwd) return null
    joined = `${trimTrailingSlash(cwd)}/${ref.replace(/^\.\//, '')}`
  }
  return normalize(joined)
}

/** Collapse `.`, `..` and duplicate separators in an absolute path. */
export function normalize(p: string): string {
  const absolute = p.startsWith('/')
  const out: string[] = []
  for (const seg of p.split('/')) {
    if (!seg || seg === '.') continue
    if (seg === '..') {
      if (out.length && out[out.length - 1] !== '..') out.pop()
      else if (!absolute) out.push('..')
      continue
    }
    out.push(seg)
  }
  const joined = out.join('/')
  return absolute ? `/${joined}` : joined
}

/** True when `child` is `parent` or sits underneath it. */
export function isInside(parent: string, child: string): boolean {
  const base = trimTrailingSlash(parent)
  if (child === base) return true
  return child.startsWith(base === '/' ? '/' : `${base}/`)
}

/** Last path segment. */
export function basename(p: string): string {
  return trimTrailingSlash(p).split('/').pop() ?? p
}

/** Everything before the last path segment. */
export function dirname(p: string): string {
  const trimmed = trimTrailingSlash(p)
  const idx = trimmed.lastIndexOf('/')
  if (idx <= 0) return '/'
  return trimmed.slice(0, idx)
}

/** `foo.ts` relative to `cwd`, or the absolute path when it lies outside. */
export function relativeTo(cwd: string | null, p: string): string {
  if (!cwd) return p
  const base = trimTrailingSlash(cwd)
  return p.startsWith(`${base}/`) ? p.slice(base.length + 1) : p
}

/**
 * Split a trailing line reference off a path: `foo.ts:42`, `foo.ts:42:7`,
 * `foo.ts#L42`. Windows-style drive letters aren't a concern (this app is POSIX
 * only), so a bare `:digits` suffix is unambiguous.
 */
export function splitLineSuffix(raw: string): { path: string; line?: number } {
  const hash = /^(.*?)#L(\d+)$/.exec(raw)
  if (hash) return { path: hash[1], line: Number(hash[2]) }
  const colon = /^(.*?):(\d+)(?::\d+)?$/.exec(raw)
  if (colon) return { path: colon[1], line: Number(colon[2]) }
  return { path: raw }
}
