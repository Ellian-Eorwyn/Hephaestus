import { promises as fs } from 'node:fs'
import path from 'node:path'
import chokidar, { type FSWatcher } from 'chokidar'
import type {
  ProjectSummary,
  SessionSummary,
  SessionRecord,
  SessionUpdatePayload,
  ModelsConfig,
  SessionDetail
} from '@shared/types'
import {
  decodeCwd,
  parseRecords,
  buildSessionDetailFromRecords,
  newSummaryAccum,
  foldSummaryRecord,
  summaryFromAccum,
  type SummaryAccum
} from './session-parse'

/**
 * Incrementally-parsed view of one session file.
 *
 * `offset` is the byte position just past the last newline we have consumed, so a
 * torn trailing line is never counted and gets picked up whole on the next read.
 */
interface TailCache {
  offset: number
  size: number
  mtimeMs: number
  records: SessionRecord[]
  /** Session header record, hoisted out so summaries don't rescan for it. */
  header?: SessionRecord
  /**
   * Running summary totals plus how many records have been folded into them.
   * Summary fields are cumulative, so an append only needs to fold the new
   * records — walking the whole session on every change is the other half of the
   * per-tick cost, and it grows with the conversation.
   */
  acc: SummaryAccum
  folded: number
  /** For LRU eviction. */
  usedAt: number
}

/**
 * Bounds on the parsed-record cache. Sessions vary enormously in size, so a plain
 * file count is a poor proxy for memory — a handful of long conversations can hold
 * hundreds of thousands of objects. Cap both the number of files and the total
 * records retained, evicting least-recently-used first.
 *
 * Only files we re-read benefit from caching (the streaming session, the one being
 * viewed, a few recent ones); the per-file *summaries* are kept separately and are
 * small, so a listing of hundreds of sessions doesn't need their records retained.
 */
const TAIL_CACHE_FILES = 12
const TAIL_CACHE_RECORDS = 120_000

export class SessionStore {
  private watchers = new Map<string, FSWatcher>()
  private tails = new Map<string, TailCache>()
  private summaries = new Map<string, SessionSummary>()
  private models = new Map<string, { mtimeMs: number; data: ModelsConfig | null }>()

  /**
   * Load and parse a harness's models.json, re-reading only when it changes.
   * This used to be re-read and re-parsed on every session load — several times a
   * second during an active turn.
   */
  async getModels(agentDir: string): Promise<ModelsConfig | null> {
    const file = path.join(agentDir, 'models.json')
    let mtimeMs = -1
    try {
      mtimeMs = (await fs.stat(file)).mtimeMs
    } catch {
      // Missing models.json is normal for a hosted/login harness like base pi.
      this.models.set(agentDir, { mtimeMs: -1, data: null })
      return null
    }
    const cached = this.models.get(agentDir)
    if (cached && cached.mtimeMs === mtimeMs) return cached.data

    let data: ModelsConfig | null = null
    try {
      data = JSON.parse(await fs.readFile(file, 'utf8')) as ModelsConfig
    } catch {
      data = null
    }
    this.models.set(agentDir, { mtimeMs, data })
    return data
  }

  /** Map of modelId -> contextWindow across all providers. */
  async contextWindows(
    agentDir: string
  ): Promise<{ byModel: Record<string, number>; fallback: number | null }> {
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

  /**
   * Records for a session file, reading only what was appended since last time.
   *
   * pi appends to session files during a turn and only ever rewrites them at
   * session open (corrupt-resume recovery or a format migration), so an
   * append-only fast path is safe — with explicit fallbacks for the rewrite cases:
   * a file that shrank below our offset, a same-length change, or a session header
   * turning up in appended content all force a full re-parse.
   */
  async readRecordsCached(filePath: string): Promise<SessionRecord[]> {
    const stat = await fs.stat(filePath)
    const { size, mtimeMs } = stat
    const cache = this.tails.get(filePath)

    if (!cache || size < cache.offset || (size === cache.offset && mtimeMs !== cache.mtimeMs)) {
      return this.fullRead(filePath, mtimeMs)
    }

    cache.usedAt = Date.now()
    if (size === cache.offset) return cache.records

    // Append-only fast path: read just the new bytes.
    const fh = await fs.open(filePath, 'r')
    try {
      const length = size - cache.offset
      const buf = Buffer.allocUnsafe(length)
      const { bytesRead } = await fh.read(buf, 0, length, cache.offset)
      const chunk = buf.subarray(0, bytesRead)
      // 0x0A cannot occur inside a UTF-8 multi-byte sequence, so cutting at the
      // last newline is always a valid decode boundary.
      const lastNl = chunk.lastIndexOf(0x0a)
      if (lastNl < 0) {
        // Nothing complete yet — the harness is mid-write.
        cache.size = size
        cache.mtimeMs = mtimeMs
        return cache.records
      }
      const consumed = lastNl + 1
      const fresh = parseRecords(chunk.subarray(0, consumed).toString('utf8'))
      // A session header in *appended* content means the file was rewritten under
      // us, not appended to; the cached prefix is no longer trustworthy.
      if (fresh.some((r) => r.type === 'session')) return this.fullRead(filePath, mtimeMs)

      for (const r of fresh) cache.records.push(r)
      cache.offset += consumed
      cache.size = size
      cache.mtimeMs = mtimeMs
      return cache.records
    } finally {
      await fh.close()
    }
  }

  private async fullRead(filePath: string, mtimeMs: number): Promise<SessionRecord[]> {
    const buf = await fs.readFile(filePath)
    const lastNl = buf.lastIndexOf(0x0a)
    const consumed = lastNl >= 0 ? lastNl + 1 : 0
    const records = consumed ? parseRecords(buf.subarray(0, consumed).toString('utf8')) : []
    this.tails.set(filePath, {
      offset: consumed,
      size: buf.length,
      mtimeMs,
      records,
      header: records.find((r) => r.type === 'session'),
      acc: newSummaryAccum(),
      folded: 0,
      usedAt: Date.now()
    })
    this.evictTails()
    return records
  }

  private evictTails(): void {
    let total = 0
    for (const c of this.tails.values()) total += c.records.length
    if (this.tails.size <= TAIL_CACHE_FILES && total <= TAIL_CACHE_RECORDS) return

    // Oldest-used first, keeping the most recently touched files — during a turn
    // that is the session being streamed, which is exactly what we re-read.
    const byAge = [...this.tails.entries()].sort((a, b) => a[1].usedAt - b[1].usedAt)
    for (const [key, cache] of byAge) {
      if (this.tails.size <= TAIL_CACHE_FILES && total <= TAIL_CACHE_RECORDS) break
      this.tails.delete(key)
      total -= cache.records.length
    }
  }

  /** Drop every cache entry for a file (deleted, or unreadable). */
  private forget(filePath: string): void {
    this.tails.delete(filePath)
    this.summaries.delete(filePath)
  }

  /**
   * Fresh summary for one session file, folding only records appended since the
   * last call so the cost tracks what changed rather than how long the
   * conversation is.
   */
  async summaryFor(filePath: string): Promise<SessionSummary> {
    const records = await this.readRecordsCached(filePath)
    const cache = this.tails.get(filePath)
    if (!cache) {
      // Shouldn't happen (readRecordsCached populates it), but stay correct if the
      // entry was evicted between the two lines.
      const acc = newSummaryAccum()
      for (const r of records) foldSummaryRecord(acc, r)
      const summary = summaryFromAccum(
        filePath,
        records.find((r) => r.type === 'session'),
        acc
      )
      this.summaries.set(filePath, summary)
      return summary
    }
    for (let i = cache.folded; i < cache.records.length; i++) {
      foldSummaryRecord(cache.acc, cache.records[i])
    }
    cache.folded = cache.records.length
    const summary = summaryFromAccum(filePath, cache.header, cache.acc)
    this.summaries.set(filePath, summary)
    return summary
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

      const sessions: SessionSummary[] = []
      let headerCwd = ''
      for (const f of files) {
        try {
          const s = await this.summaryFor(path.join(dir, f))
          if (!headerCwd && s.cwd) headerCwd = s.cwd
          sessions.push(s)
        } catch {
          // skip unreadable session
        }
      }
      sessions.sort((a, b) => (a.timestamp < b.timestamp ? 1 : -1))

      // Prefer the authoritative cwd from the session header; fall back to a
      // .project.json metadata file (written when users add projects via the UI);
      // last resort is the lossy decodeCwd from the folder name.
      let cwd = headerCwd
      if (!cwd) {
        try {
          const meta = JSON.parse(await fs.readFile(path.join(dir, '.project.json'), 'utf8'))
          if (meta.cwd) cwd = meta.cwd
        } catch {
          // no metadata file
        }
      }
      if (!cwd) cwd = decodeCwd(encoded)
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
    const records = await this.readRecordsCached(filePath)
    return buildSessionDetailFromRecords(filePath, records, {
      contextWindowByModel: byModel,
      defaultContextWindow: fallback
    })
  }

  /**
   * Watch a harness's sessions/ tree, invoking onChange for any add/change of a
   * .jsonl file.
   *
   * No awaitWriteFinish: it holds the event until writes stop, which for an active
   * turn is only at the very end. We want a session to surface the instant the
   * harness writes to it, so we fire on raw events and debounce per file instead —
   * partial trailing lines are tolerated by the parser.
   *
   * The payload carries a freshly-computed summary. Computing it here (off the
   * incremental cache) is what lets the renderer patch a single sidebar row rather
   * than re-listing every project, which previously meant re-reading and
   * re-parsing the harness's entire session corpus several times a second.
   */
  watch(
    harnessId: string,
    agentDir: string,
    onChange: (payload: SessionUpdatePayload) => void
  ): void {
    if (this.watchers.has(harnessId)) return
    const sessionsDir = path.join(agentDir, 'sessions')
    const watcher = chokidar.watch(sessionsDir, { ignoreInitial: true, depth: 2 })
    const timers = new Map<string, ReturnType<typeof setTimeout>>()

    const handler = (filePath: string) => {
      if (!filePath.endsWith('.jsonl')) return
      const t = timers.get(filePath)
      if (t) clearTimeout(t)
      timers.set(
        filePath,
        setTimeout(() => {
          timers.delete(filePath)
          void this.emitUpdate(harnessId, filePath, onChange)
        }, 80)
      )
    }

    watcher
      .on('add', handler)
      .on('change', handler)
      // Deleting a session must not leave a stale cached prefix behind for a file
      // that may later be recreated at the same path.
      .on('unlink', (filePath: string) => {
        if (filePath.endsWith('.jsonl')) this.forget(filePath)
      })
    this.watchers.set(harnessId, watcher)
  }

  private async emitUpdate(
    harnessId: string,
    filePath: string,
    onChange: (payload: SessionUpdatePayload) => void
  ): Promise<void> {
    const isNew = !this.summaries.has(filePath)
    let summary: SessionSummary | null = null
    try {
      summary = await this.summaryFor(filePath)
    } catch {
      // Unreadable (deleted mid-flight, or not yet flushed) — report the change
      // without a summary and let the renderer fall back to a full refresh.
      this.forget(filePath)
    }
    onChange({
      harnessId,
      path: filePath,
      projectEncoded: path.basename(path.dirname(filePath)),
      summary,
      isNew
    })
  }

  async dispose(): Promise<void> {
    for (const w of this.watchers.values()) await w.close()
    this.watchers.clear()
    this.tails.clear()
    this.summaries.clear()
    this.models.clear()
  }
}
