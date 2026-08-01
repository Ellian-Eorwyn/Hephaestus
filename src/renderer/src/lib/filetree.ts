/**
 * Immutable helpers for the lazily-loaded file tree.
 *
 * The tree arrives one directory level at a time (see `FileService.listDir`), so
 * the renderer has to splice fetched children into an existing tree, refresh only
 * the levels that actually changed, and keep already-expanded subtrees intact
 * across a refresh. Everything here returns new arrays so zustand's identity
 * checks still do their job.
 */
import type { FileNode } from '@shared/types'

/** The node at `target`, or null. Depth-first over loaded nodes only. */
export function findNode(nodes: FileNode[], target: string): FileNode | null {
  for (const n of nodes) {
    if (n.path === target) return n
    if (n.children) {
      const hit = findNode(n.children, target)
      if (hit) return hit
    }
  }
  return null
}

/**
 * Replace the children of `dirPath`, carrying over any already-loaded subtree of a
 * directory that survived the refresh — so re-listing a level never collapses the
 * folders the user has open below it.
 */
export function setChildren(
  nodes: FileNode[],
  dirPath: string,
  children: FileNode[],
  truncated = false
): FileNode[] {
  let changed = false
  const next = nodes.map((n) => {
    if (n.path === dirPath && n.type === 'dir') {
      changed = true
      return {
        ...n,
        children: mergeListing(n.children, children),
        loaded: true,
        hasChildren: children.length > 0,
        truncated
      }
    }
    if (n.children) {
      const sub = setChildren(n.children, dirPath, children, truncated)
      if (sub !== n.children) {
        changed = true
        return { ...n, children: sub }
      }
    }
    return n
  })
  return changed ? next : nodes
}

/** Carry loaded subtrees from `prev` onto the freshly-listed `fresh` nodes. */
export function mergeListing(prev: FileNode[] | undefined, fresh: FileNode[]): FileNode[] {
  if (!prev?.length) return fresh
  const byPath = new Map(prev.map((n) => [n.path, n]))
  return fresh.map((n) => {
    const old = byPath.get(n.path)
    if (n.type !== 'dir' || !old || old.type !== 'dir' || !old.loaded) return n
    return { ...n, children: old.children, loaded: true, truncated: old.truncated }
  })
}

/** Absolute paths of every directory whose children have been fetched. */
export function loadedDirs(nodes: FileNode[], out: string[] = []): string[] {
  for (const n of nodes) {
    if (n.type === 'dir' && n.loaded) {
      out.push(n.path)
      if (n.children) loadedDirs(n.children, out)
    }
  }
  return out
}

/**
 * Every *file* currently in the tree. Used to decide whether a string in an agent
 * reply is a real file worth linking — validating against what we actually listed is
 * what keeps the heuristic link forms from underlining random prose.
 */
export function collectPaths(nodes: FileNode[], out: Set<string> = new Set()): Set<string> {
  for (const n of nodes) {
    // Files only: this feeds file-reference resolution, and a link to a directory
    // has nothing to show in the preview.
    if (n.type === 'file') out.add(n.path)
    if (n.children) collectPaths(n.children, out)
  }
  return out
}

/**
 * Directories between `root` (exclusive) and `filePath` (exclusive), outermost
 * first — the chain that has to be expanded and loaded to reveal a file.
 */
export function ancestorDirs(root: string, filePath: string): string[] {
  const base = root.replace(/\/+$/, '')
  if (!filePath.startsWith(`${base}/`)) return []
  const rel = filePath.slice(base.length + 1)
  const parts = rel.split('/')
  parts.pop() // the file itself
  const out: string[] = []
  let acc = base
  for (const p of parts) {
    acc = `${acc}/${p}`
    out.push(acc)
  }
  return out
}
