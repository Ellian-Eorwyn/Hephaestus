import { promises as fs } from 'node:fs'
import path from 'node:path'
import type { FileNode, FileContent } from '@shared/types'

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
const MAX_BYTES = 1_000_000 // 1MB cap for preview

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

function isProbablyText(filePath: string): boolean {
  const ext = path.extname(filePath).toLowerCase()
  const base = path.basename(filePath).toLowerCase()
  if (ext === '') {
    return ['dockerfile', 'makefile', 'license', 'readme', '.gitignore', '.env'].some((n) => base.includes(n))
  }
  return ['.cfg', '.ini', '.conf', '.lock', '.gitignore', '.env'].includes(ext)
}
