import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { app } from 'electron'
import type { HarnessConfig } from '@shared/types'

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
    // Resolve CLI launchers lazily on each load (cheap; absence only disables sending).
    for (const h of this.harnesses) {
      if (!h.cli) h.cli = await resolveCli(h.agentDir)
    }
    return this.list()
  }

  list(): HarnessConfig[] {
    return this.harnesses.map((h) => ({ ...h }))
  }

  get(id: string): HarnessConfig | undefined {
    return this.harnesses.find((h) => h.id === id)
  }

  async add(input: { label: string; agentDir: string }): Promise<HarnessConfig[]> {
    const agentDir = expandHome(input.agentDir)
    const id = slugify(input.label) || `harness-${this.harnesses.length + 1}`
    let uniqueId = id
    let n = 2
    while (this.harnesses.some((h) => h.id === uniqueId)) uniqueId = `${id}-${n++}`
    const cli = await resolveCli(agentDir)
    this.harnesses.push({ id: uniqueId, label: input.label, agentDir, cli })
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
 * file and return its absolute path, or null when none is found.
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
    if (candidates.length === 0) return null
    // Prefer a launcher whose name looks like a pi/forge entry.
    const preferred = candidates.find((c) => /\bpi[-_]?|forge|vault/i.test(path.basename(c)))
    return preferred ?? candidates[0]
  } catch {
    return null
  }
}

export { expandHome }
