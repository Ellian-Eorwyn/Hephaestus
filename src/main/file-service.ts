import { promises as fs } from 'node:fs'
import path from 'node:path'
import * as XLSX from 'xlsx'
import type {
  FileNode,
  FileContent,
  FileChange,
  FileChangeType,
  ProjectChangePayload,
  SheetData
} from '@shared/types'

import chokidar from 'chokidar'

const IGNORE = new Set(['.git', 'node_modules', '.DS_Store', '.venv', 'venv', '__pycache__', 'dist', 'out', '.next'])

/**
 * chokidar `ignored` predicate covering noisy dirs and dotfiles (except the few we
 * surface in the tree).
 *
 * Only segments *below the watched root* are tested. Testing the absolute path
 * meant a project living under any dot-directory or any `dist`/`out` ancestor —
 * `~/.config/foo`, say, or an Obsidian vault under `~/.obsidian` — matched its own
 * root and silently received zero events, so nothing in it ever updated live.
 */
function isIgnoredPath(root: string, p: string): boolean {
  const rel = path.relative(root, p)
  if (!rel) return false
  // Outside the root entirely: nothing we care about.
  if (rel.startsWith('..') || path.isAbsolute(rel)) return true
  for (const seg of rel.split(path.sep)) {
    if (!seg) continue
    if (IGNORE.has(seg)) return true
    if (seg.startsWith('.') && seg !== '.gitignore') return true
  }
  return false
}

/** Depth chokidar/readDir descend into a project before stopping. */
const WATCH_DEPTH = 8
/** Coalescing window for filesystem bursts. */
const CHANGE_DEBOUNCE_MS = 60
/** Beyond this many distinct paths in one window we stop enumerating and flag overflow. */
const MAX_CHANGES = 200
/**
 * How many projects to keep watched. Background runs in other projects still need
 * their trees fresh, but an unbounded map meant every project ever opened kept a
 * recursive watcher alive until the app quit.
 */
const MAX_WATCHERS = 3

const CODE_LANGS: Record<string, string> = {
  '.ts': 'typescript',
  '.tsx': 'tsx',
  '.js': 'javascript',
  '.jsx': 'jsx',
  '.mjs': 'javascript',
  '.cjs': 'javascript',
  '.json': 'json',
  '.py': 'python',
  '.rb': 'ruby',
  '.go': 'go',
  '.rs': 'rust',
  '.java': 'java',
  '.c': 'c',
  '.h': 'c',
  '.cpp': 'cpp',
  '.cc': 'cpp',
  '.cs': 'csharp',
  '.sh': 'bash',
  '.bash': 'bash',
  '.zsh': 'bash',
  '.yml': 'yaml',
  '.yaml': 'yaml',
  '.toml': 'toml',
  '.html': 'html',
  '.css': 'css',
  '.scss': 'scss',
  '.sql': 'sql',
  '.swift': 'swift',
  '.kt': 'kotlin',
  '.php': 'php',
  '.xml': 'xml',
  '.txt': 'text'
}

const MARKDOWN_EXT = new Set(['.md', '.markdown', '.mdx'])
const SPREADSHEET_EXT = new Set(['.csv', '.tsv', '.xlsx', '.xlsm', '.xls', '.ods'])
const JSONL_EXT = new Set(['.jsonl', '.ndjson'])
const MAX_BYTES = 1_000_000 // 1MB cap for text preview
const MAX_SHEET_BYTES = 15_000_000 // 15MB cap for spreadsheet parsing
const MAX_ROWS = 1000
const MAX_COLS = 60

/** A watched project and the change burst currently accumulating for it. */
interface ProjectWatch {
  watcher: chokidar.FSWatcher
  onChange: (payload: ProjectChangePayload) => void
  pending: Map<string, FileChange>
  timer: NodeJS.Timeout | null
  overflow: boolean
  usedAt: number
}

export class FileService {
  // One watcher per project cwd so concurrent/background runs all keep their
  // file trees fresh — not a single watcher tied to the visible selection.
  private watchers = new Map<string, ProjectWatch>()

  /** Build a file tree for the given cwd, recursing up to WATCH_DEPTH levels. */
  async listFiles(cwd: string): Promise<FileNode[]> {
    return this.readDir(cwd, WATCH_DEPTH)
  }

  /**
   * Watch a project directory, coalescing change bursts into a single payload that
   * names the paths involved.
   *
   * Re-watching an already-watched cwd refreshes its position in the LRU and
   * adopts the new callback rather than tearing the watcher down, so re-selecting
   * a project never disturbs a watcher a background run depends on.
   */
  watch(cwd: string, onChange: (payload: ProjectChangePayload) => void): void {
    const key = path.resolve(cwd)
    const existing = this.watchers.get(key)
    if (existing) {
      existing.onChange = onChange
      existing.usedAt = Date.now()
      return
    }

    // Coalesce rapid bursts but stay snappy. We deliberately do NOT use
    // awaitWriteFinish: a file should surface the instant it's created rather than
    // after its content settles, and the stat we attach lets the renderer decide
    // whether a re-read is actually needed.
    const watcher = chokidar.watch(key, {
      ignored: (p: string) => isIgnoredPath(key, p),
      ignoreInitial: true,
      alwaysStat: true,
      depth: WATCH_DEPTH
    })

    const entry: ProjectWatch = {
      watcher,
      onChange,
      pending: new Map(),
      timer: null,
      overflow: false,
      usedAt: Date.now()
    }

    watcher.on('all', (event: string, changedPath: string, stats?: { size: number; mtimeMs: number }) => {
      if (!isFileChangeType(event)) return
      // chokidar reports an `addDir` for the watched root itself even with
      // ignoreInitial, which would make the first edit in every project look like
      // a structural change and force a needless full re-listing.
      if (changedPath === key && (event === 'addDir' || event === 'unlinkDir')) return
      if (entry.pending.size >= MAX_CHANGES && !entry.pending.has(changedPath)) {
        // A mass event (install, branch switch). Stop enumerating; the renderer
        // treats overflow as "re-check everything".
        entry.overflow = true
      } else {
        entry.pending.set(changedPath, {
          type: event,
          path: changedPath,
          size: stats?.size,
          mtimeMs: stats?.mtimeMs
        })
      }
      if (entry.timer) clearTimeout(entry.timer)
      entry.timer = setTimeout(() => {
        entry.timer = null
        const changes = [...entry.pending.values()]
        const overflow = entry.overflow
        entry.pending.clear()
        entry.overflow = false
        if (changes.length || overflow) entry.onChange({ cwd: key, changes, overflow })
      }, CHANGE_DEBOUNCE_MS)
    })

    this.watchers.set(key, entry)
    this.evictWatchers()
  }

  /** Close the least-recently-selected watchers once we're over the cap. */
  private evictWatchers(): void {
    if (this.watchers.size <= MAX_WATCHERS) return
    const byAge = [...this.watchers.entries()].sort((a, b) => a[1].usedAt - b[1].usedAt)
    for (const [key, entry] of byAge) {
      if (this.watchers.size <= MAX_WATCHERS) break
      if (entry.timer) clearTimeout(entry.timer)
      void entry.watcher.close()
      this.watchers.delete(key)
    }
  }

  dispose(): void {
    for (const w of this.watchers.values()) {
      if (w.timer) clearTimeout(w.timer)
      void w.watcher.close()
    }
    this.watchers.clear()
  }

  private async readDir(dir: string, depth: number): Promise<FileNode[]> {
    let entries
    try {
      entries = await fs.readdir(dir, { withFileTypes: true })
    } catch {
      return []
    }
    const nodes: FileNode[] = []
    for (const e of entries) {
      if (IGNORE.has(e.name)) continue
      if (e.name.startsWith('.') && e.name !== '.gitignore') continue
      const full = path.join(dir, e.name)
      if (e.isDirectory()) {
        nodes.push({
          name: e.name,
          path: full,
          type: 'dir',
          children: depth > 0 ? await this.readDir(full, depth - 1) : []
        })
      } else if (e.isFile()) {
        nodes.push({ name: e.name, path: full, type: 'file' })
      }
    }
    nodes.sort((a, b) => {
      if (a.type !== b.type) return a.type === 'dir' ? -1 : 1
      return a.name.localeCompare(b.name)
    })
    return nodes
  }

  async readFile(filePath: string): Promise<FileContent> {
    const ext = path.extname(filePath).toLowerCase()
    const stat = await fs.stat(filePath)
    const truncated = stat.size > MAX_BYTES
    // Stamp every result so a watcher event can be compared against what's on
    // screen and skipped when the bytes are unchanged.
    const at = { size: stat.size, mtimeMs: stat.mtimeMs }

    if (ext === '.json' && stat.size <= MAX_SHEET_BYTES) {
      const sheets = await this.readJsonArray(filePath)
      if (sheets) {
        return { path: filePath, kind: 'spreadsheet', content: '', sheets, truncated: false, ...at }
      }
    }

    if (JSONL_EXT.has(ext)) {
      if (stat.size > MAX_SHEET_BYTES) {
        return { path: filePath, kind: 'binary', content: '', truncated: true, ...at }
      }
      const sheets = await this.readJsonl(filePath)
      return { path: filePath, kind: 'spreadsheet', content: '', sheets, truncated: false, ...at }
    }

    if (SPREADSHEET_EXT.has(ext)) {
      if (stat.size > MAX_SHEET_BYTES) {
        return { path: filePath, kind: 'binary', content: '', truncated: true, ...at }
      }
      const sheets = await this.readSpreadsheet(filePath)
      return { path: filePath, kind: 'spreadsheet', content: '', sheets, truncated: false, ...at }
    }

    if (MARKDOWN_EXT.has(ext)) {
      const content = await this.readText(filePath, truncated)
      return { path: filePath, kind: 'markdown', content, truncated, ...at }
    }
    if (CODE_LANGS[ext] || isProbablyText(filePath)) {
      const content = await this.readText(filePath, truncated)
      return {
        path: filePath,
        kind: 'code',
        language: CODE_LANGS[ext] ?? 'text',
        content,
        truncated,
        ...at
      }
    }
    return { path: filePath, kind: 'binary', content: '', truncated: false, ...at }
  }

  /**
   * Parse a spreadsheet (csv/tsv/xls/xlsx/ods) into one or more sheets of string
   * cells via SheetJS. Each sheet is clipped to MAX_ROWS x MAX_COLS for preview.
   */
  private async readSpreadsheet(filePath: string): Promise<SheetData[]> {
    const buf = await fs.readFile(filePath)
    // SheetJS auto-detects the format (csv, tsv, xlsx, …) from the buffer.
    const wb = XLSX.read(buf, { type: 'buffer', cellDates: true, dense: false })
    const sheets: SheetData[] = []
    for (const name of wb.SheetNames) {
      const ws = wb.Sheets[name]
      if (!ws) continue
      // header:1 => array-of-arrays; defval keeps empty cells aligned.
      const aoa = XLSX.utils.sheet_to_json<unknown[]>(ws, { header: 1, defval: '', blankrows: false })
      let clipped = false
      const rows: string[][] = []
      for (const row of aoa) {
        if (rows.length >= MAX_ROWS) {
          clipped = true
          break
        }
        const cells = (row as unknown[]).slice(0, MAX_COLS).map((c) => cellToString(c))
        if ((row as unknown[]).length > MAX_COLS) clipped = true
        rows.push(cells)
      }
      sheets.push({ name, rows, clipped })
    }
    return sheets.length ? sheets : [{ name: 'Sheet1', rows: [] }]
  }

  private async readText(filePath: string, truncated: boolean): Promise<string> {
    if (!truncated) return fs.readFile(filePath, 'utf8')
    const handle = await fs.open(filePath, 'r')
    try {
      const buf = Buffer.alloc(MAX_BYTES)
      const { bytesRead } = await handle.read(buf, 0, MAX_BYTES, 0)
      return buf.subarray(0, bytesRead).toString('utf8')
    } finally {
      await handle.close()
    }
  }

  /**
   * Parse a JSONL / NDJSON file into a spreadsheet. Each line is a JSON object;
   * the union of all keys becomes the header row and each object becomes a data
   * row. Nested values are JSON-stringified.
   */
  private async readJsonl(filePath: string): Promise<SheetData[]> {
    const raw = await fs.readFile(filePath, 'utf8')
    const lines = raw.split('\n').filter((l) => l.trim())
    const objects: Record<string, unknown>[] = []
    const keyOrder: string[] = []
    const keySeen = new Set<string>()

    let clipped = false
    for (const line of lines) {
      if (objects.length >= MAX_ROWS) {
        clipped = true
        break
      }
      try {
        const obj = JSON.parse(line)
        if (typeof obj === 'object' && obj !== null && !Array.isArray(obj)) {
          for (const k of Object.keys(obj)) {
            if (!keySeen.has(k)) {
              keySeen.add(k)
              keyOrder.push(k)
            }
          }
          objects.push(obj as Record<string, unknown>)
        }
      } catch {
        // skip malformed lines
      }
    }

    const cols = keyOrder.slice(0, MAX_COLS)
    if (keyOrder.length > MAX_COLS) clipped = true
    const header = cols
    const rows: string[][] = [header]
    for (const obj of objects) {
      rows.push(cols.map((k) => jsonlCellToString(obj[k])))
    }
    return [{ name: path.basename(filePath), rows, clipped }]
  }

  /**
   * Parse a JSON file. If it's an array of objects, convert it into a spreadsheet.
   * Returns null if it's not an array of objects or if parsing fails.
   */
  private async readJsonArray(filePath: string): Promise<SheetData[] | null> {
    try {
      const raw = await fs.readFile(filePath, 'utf8')
      const parsed = JSON.parse(raw)
      
      if (!Array.isArray(parsed) || parsed.length === 0) {
        return null
      }

      // Check if it's an array of objects
      const isArrayOfObjects = parsed.some(
        (item) => typeof item === 'object' && item !== null && !Array.isArray(item)
      )
      
      if (!isArrayOfObjects) {
        return null
      }

      const objects: Record<string, unknown>[] = []
      const keyOrder: string[] = []
      const keySeen = new Set<string>()
      let clipped = false

      for (const item of parsed) {
        if (objects.length >= MAX_ROWS) {
          clipped = true
          break
        }
        if (typeof item === 'object' && item !== null && !Array.isArray(item)) {
          for (const k of Object.keys(item)) {
            if (!keySeen.has(k)) {
              keySeen.add(k)
              keyOrder.push(k)
            }
          }
          objects.push(item as Record<string, unknown>)
        }
      }

      const cols = keyOrder.slice(0, MAX_COLS)
      if (keyOrder.length > MAX_COLS) clipped = true
      const header = cols
      const rows: string[][] = [header]
      for (const obj of objects) {
        rows.push(cols.map((k) => jsonlCellToString(obj[k])))
      }
      return [{ name: path.basename(filePath), rows, clipped }]
    } catch {
      return null
    }
  }
}

function cellToString(c: unknown): string {
  if (c == null) return ''
  if (c instanceof Date) return c.toISOString().slice(0, 10)
  return String(c)
}

function jsonlCellToString(c: unknown): string {
  if (c == null) return ''
  if (typeof c === 'object') {
    try {
      return JSON.stringify(c)
    } catch {
      return String(c)
    }
  }
  return String(c)
}

const FILE_CHANGE_TYPES = new Set<string>(['add', 'change', 'unlink', 'addDir', 'unlinkDir'])
function isFileChangeType(event: string): event is FileChangeType {
  return FILE_CHANGE_TYPES.has(event)
}

function isProbablyText(filePath: string): boolean {
  const ext = path.extname(filePath).toLowerCase()
  const base = path.basename(filePath).toLowerCase()
  if (ext === '') {
    return ['dockerfile', 'makefile', 'license', 'readme', '.gitignore', '.env'].some((n) => base.includes(n))
  }
  return ['.cfg', '.ini', '.conf', '.lock', '.gitignore', '.env'].includes(ext)
}
