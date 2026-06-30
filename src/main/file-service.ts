import { promises as fs } from 'node:fs'
import path from 'node:path'
import * as XLSX from 'xlsx'
import type { FileNode, FileContent, SheetData } from '@shared/types'

const IGNORE = new Set(['.git', 'node_modules', '.DS_Store', '.venv', 'venv', '__pycache__', 'dist', 'out', '.next'])

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
const MAX_BYTES = 1_000_000 // 1MB cap for text preview
const MAX_SHEET_BYTES = 15_000_000 // 15MB cap for spreadsheet parsing
const MAX_ROWS = 1000
const MAX_COLS = 60

export class FileService {
  /** Build a (lazily shallow) file tree for the given cwd, 1 level recursive per dir. */
  async listFiles(cwd: string): Promise<FileNode[]> {
    return this.readDir(cwd, 4)
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

    if (SPREADSHEET_EXT.has(ext)) {
      if (stat.size > MAX_SHEET_BYTES) {
        return { path: filePath, kind: 'binary', content: '', truncated: true }
      }
      const sheets = await this.readSpreadsheet(filePath)
      return { path: filePath, kind: 'spreadsheet', content: '', sheets, truncated: false }
    }

    if (MARKDOWN_EXT.has(ext)) {
      const content = await this.readText(filePath, truncated)
      return { path: filePath, kind: 'markdown', content, truncated }
    }
    if (CODE_LANGS[ext] || isProbablyText(filePath)) {
      const content = await this.readText(filePath, truncated)
      return { path: filePath, kind: 'code', language: CODE_LANGS[ext] ?? 'text', content, truncated }
    }
    return { path: filePath, kind: 'binary', content: '', truncated: false }
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
}

function cellToString(c: unknown): string {
  if (c == null) return ''
  if (c instanceof Date) return c.toISOString().slice(0, 10)
  return String(c)
}

function isProbablyText(filePath: string): boolean {
  const ext = path.extname(filePath).toLowerCase()
  const base = path.basename(filePath).toLowerCase()
  if (ext === '') {
    return ['dockerfile', 'makefile', 'license', 'readme', '.gitignore', '.env'].some((n) => base.includes(n))
  }
  return ['.cfg', '.ini', '.conf', '.lock', '.gitignore', '.env'].includes(ext)
}
