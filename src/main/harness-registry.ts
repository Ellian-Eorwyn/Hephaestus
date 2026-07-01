import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { app } from 'electron'
import type { HarnessConfig } from '@shared/types'
import { whichInPath } from './paths'

function expandHome(p: string): string {
  if (p === '~') return os.homedir()
  if (p.startsWith('~/')) return path.join(os.homedir(), p.slice(2))
  return p
}

const DEFAULT_HARNESSES: HarnessConfig[] = [
  { id: 'forge', label: 'Forge', agentDir: expandHome('~/.pi-forge/agent'), cli: null },
  { id: 'vault', label: 'Vault', agentDir: expandHome('~/.pi-vault/agent'), cli: null }
]

export class HarnessRegistry {
  private configPath: string
  private harnesses: HarnessConfig[] = []

  constructor() {
    this.configPath = path.join(app.getPath('userData'), 'harnesses.json')
  }

  async load(): Promise<HarnessConfig[]> {
    try {
      const raw = await fs.readFile(this.configPath, 'utf8')
      const parsed = JSON.parse(raw) as { harnesses: HarnessConfig[] }
      this.harnesses = parsed.harnesses ?? []
    } catch {
      // First run (or unreadable): seed with the two known harnesses.
      this.harnesses = DEFAULT_HARNESSES.map((h) => ({ ...h }))
      await this.persist()
    }
    // Auto-register any harnesses found under the home dir that aren't already
    // known (e.g. a base `~/.pi` install), so users don't have to type paths.
    let added = false
    const known = new Set(this.harnesses.map((h) => normalizeDir(h.agentDir)))
    for (const found of await discover()) {
      if (known.has(normalizeDir(found.agentDir))) continue
      const id = this.uniqueId(slugify(found.label) || 'harness')
      this.harnesses.push({ id, label: found.label, agentDir: found.agentDir, cli: null })
      known.add(normalizeDir(found.agentDir))
      added = true
    }
    if (added) await this.persist()
    // Resolve CLI launchers lazily on each load (cheap; absence only disables sending).
    for (const h of this.harnesses) {
      if (!h.cli) h.cli = await resolveCli(h.agentDir)
    }
    return this.list()
  }

  private uniqueId(base: string): string {
    let id = base
    let n = 2
    while (this.harnesses.some((h) => h.id === id)) id = `${base}-${n++}`
    return id
  }

  list(): HarnessConfig[] {
    return this.harnesses.map((h) => ({ ...h }))
  }

  get(id: string): HarnessConfig | undefined {
    return this.harnesses.find((h) => h.id === id)
  }

  async add(input: { label: string; agentDir: string }): Promise<HarnessConfig[]> {
    const agentDir = expandHome(input.agentDir)
    const id = this.uniqueId(slugify(input.label) || `harness-${this.harnesses.length + 1}`)
    const cli = await resolveCli(agentDir)
    this.harnesses.push({ id, label: input.label, agentDir, cli })
    await this.persist()
    return this.list()
  }

  async remove(id: string): Promise<HarnessConfig[]> {
    this.harnesses = this.harnesses.filter((h) => h.id !== id)
    await this.persist()
    return this.list()
  }

  private async persist(): Promise<void> {
    await fs.writeFile(this.configPath, JSON.stringify({ harnesses: this.harnesses }, null, 2), 'utf8')
  }
}

/** Normalize an agent-dir path for dedupe comparison (expand ~, trim trailing /). */
export function normalizeDir(p: string): string {
  return path.resolve(expandHome(p)).replace(/\/+$/, '')
}

/**
 * Scan the home directory (top level only) for pi/forge-style harnesses to
 * auto-register: a dot-dir whose `agent/` subdir holds `settings.json` or a
 * `sessions/` dir. Returns `{ label, agentDir }` candidates; the caller dedupes
 * against already-registered harnesses.
 */
export async function discover(): Promise<{ label: string; agentDir: string }[]> {
  const home = os.homedir()
  let entries: string[]
  try {
    entries = await fs.readdir(home)
  } catch {
    return []
  }
  const found: { label: string; agentDir: string }[] = []
  for (const name of entries) {
    if (!name.startsWith('.')) continue
    const agentDir = path.join(home, name, 'agent')
    try {
      if (!(await fs.stat(agentDir)).isDirectory()) continue
      const hasSettings = await exists(path.join(agentDir, 'settings.json'))
      const hasSessions = await exists(path.join(agentDir, 'sessions'))
      if (!hasSettings && !hasSessions) continue
      found.push({ label: prettyLabel(name), agentDir })
    } catch {
      // not a harness dir; skip
    }
  }
  return found
}

async function exists(p: string): Promise<boolean> {
  try {
    await fs.stat(p)
    return true
  } catch {
    return false
  }
}

/** `.pi` → "Pi", `.pi-forge` → "Pi Forge". */
function prettyLabel(dirName: string): string {
  return dirName
    .replace(/^\./, '')
    .split(/[-_]/)
    .filter(Boolean)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(' ')
}

function slugify(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
}

/**
 * Best-effort resolution of the CLI launcher used to run `--mode rpc`.
 *
 * pi/forge harnesses ship an executable bash launcher in a `bin/` directory that
 * is a sibling of `agent/` (e.g. `~/.pi-forge/bin/pi-forge`). That script sets up
 * required env (PI_CODING_AGENT_DIR, version-skip, etc.) and then execs the
 * bundled `coding-agent/dist/cli.js`, so we must spawn the launcher itself rather
 * than node + the dist entry. We look in `<harnessRoot>/bin/` for an executable
 * file first. A base install (e.g. `~/.pi`) ships no such wrapper — its launcher
 * is the global CLI on PATH named after the harness dir — so we fall back to a
 * PATH lookup of that name. Returns the absolute path, or null when none is found.
 */
export async function resolveCli(agentDir: string): Promise<string | null> {
  const harnessRoot = path.dirname(expandHome(agentDir))
  const binDir = path.join(harnessRoot, 'bin')
  try {
    const entries = await fs.readdir(binDir)
    const candidates: string[] = []
    for (const name of entries) {
      const full = path.join(binDir, name)
      try {
        const st = await fs.stat(full)
        // Executable bit for owner.
        if (st.isFile() && (st.mode & 0o100) !== 0) candidates.push(full)
      } catch {
        // ignore
      }
    }
    if (candidates.length > 0) {
      // Prefer a launcher whose name looks like a pi/forge entry.
      const preferred = candidates.find((c) => /\bpi[-_]?|forge|vault/i.test(path.basename(c)))
      return preferred ?? candidates[0]
    }
  } catch {
    // No bin/ dir — fall through to the global-binary lookup below.
  }
  // Base pi (and similar) ship no per-harness launcher; the launcher is the
  // global CLI on PATH, named after the harness dir (`~/.pi` → `pi`,
  // `~/.pi-forge` → `pi-forge`). Resolve that against the augmented PATH.
  const cmd = path.basename(harnessRoot).replace(/^\./, '')
  if (cmd) {
    const onPath = await whichInPath(cmd)
    if (onPath) return onPath
  }
  return null
}

export { expandHome }
