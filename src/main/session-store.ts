import { promises as fs } from 'node:fs'
import path from 'node:path'
import chokidar, { type FSWatcher } from 'chokidar'
import type {
  ProjectSummary,
  SessionSummary,
  ModelsConfig,
  SessionDetail
} from '@shared/types'
import { decodeCwd, buildSessionDetail, summarize } from './session-parse'

export class SessionStore {
  private watchers = new Map<string, FSWatcher>()

  /** Load and parse a harness's models.json. */
  async getModels(agentDir: string): Promise<ModelsConfig | null> {
    try {
      const raw = await fs.readFile(path.join(agentDir, 'models.json'), 'utf8')
      return JSON.parse(raw) as ModelsConfig
    } catch {
      return null
    }
  }

  /** Map of modelId -> contextWindow across all providers. */
  async contextWindows(agentDir: string): Promise<{ byModel: Record<string, number>; fallback: number | null }> {
    const models = await this.getModels(agentDir)
    const byModel: Record<string, number> = {}
    let fallback: number | null = null
    if (models) {
      for (const provider of Object.values(models.providers)) {
        for (const m of provider.models) {
          byModel[m.id] = m.contextWindow
          if (fallback == null) fallback = m.contextWindow
        }
      }
    }
    return { byModel, fallback }
  }

  /** List projects (decoded cwds) and their sessions for a harness. */
  async listProjects(agentDir: string): Promise<ProjectSummary[]> {
    const sessionsDir = path.join(agentDir, 'sessions')
    let entries: string[]
    try {
      entries = await fs.readdir(sessionsDir)
    } catch {
      return []
    }

    const projects: ProjectSummary[] = []
    for (const encoded of entries) {
      const dir = path.join(sessionsDir, encoded)
      let stat
      try {
        stat = await fs.stat(dir)
      } catch {
        continue
      }
      if (!stat.isDirectory()) continue

      let files: string[]
      try {
        files = (await fs.readdir(dir)).filter((f) => f.endsWith('.jsonl'))
      } catch {
        continue
      }
      if (files.length === 0) continue

      const sessions: SessionSummary[] = []
      let headerCwd = ''
      for (const f of files) {
        try {
          const s = await summarize(path.join(dir, f))
          if (!headerCwd && s.cwd) headerCwd = s.cwd
          sessions.push(s)
        } catch {
          // skip unreadable session
        }
      }
      sessions.sort((a, b) => (a.timestamp < b.timestamp ? 1 : -1))

      // Prefer the authoritative cwd from the session header; the folder name is
      // a lossy encoding (real hyphens are indistinguishable from separators).
      const cwd = headerCwd || decodeCwd(encoded)
      projects.push({
        cwd,
        name: path.basename(cwd) || cwd,
        encoded,
        sessions
      })
    }

    // Most recently active projects first.
    projects.sort((a, b) => {
      const ta = a.sessions[0]?.timestamp ?? ''
      const tb = b.sessions[0]?.timestamp ?? ''
      return ta < tb ? 1 : -1
    })
    return projects
  }

  async loadSession(agentDir: string, filePath: string): Promise<SessionDetail> {
    const { byModel, fallback } = await this.contextWindows(agentDir)
    return buildSessionDetail(filePath, {
      contextWindowByModel: byModel,
      defaultContextWindow: fallback
    })
  }

  /**
   * Watch a harness's sessions/ tree, invoking onChange(filePath) on any
   * add/change of a .jsonl file (debounced by chokidar's awaitWriteFinish).
   */
  watch(harnessId: string, agentDir: string, onChange: (filePath: string) => void): void {
    if (this.watchers.has(harnessId)) return
    const sessionsDir = path.join(agentDir, 'sessions')
    const watcher = chokidar.watch(sessionsDir, {
      ignoreInitial: true,
      depth: 2,
      awaitWriteFinish: { stabilityThreshold: 250, pollInterval: 50 }
    })
    const handler = (filePath: string) => {
      if (filePath.endsWith('.jsonl')) onChange(filePath)
    }
    watcher.on('add', handler).on('change', handler)
    this.watchers.set(harnessId, watcher)
  }

  async dispose(): Promise<void> {
    for (const w of this.watchers.values()) await w.close()
    this.watchers.clear()
  }
}
