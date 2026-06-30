import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import readline from 'node:readline'
import path from 'node:path'
import { existsSync } from 'node:fs'
import type { AgentEvent, HarnessConfig, RunSnapshot, RunStatus } from '@shared/types'

/**
 * Drives a harness's runtime in headless RPC mode. We spawn
 * `<launcher> --mode rpc` with the project cwd, write JSON command lines to its
 * stdin, and parse JSONL events from its stdout — forwarding them to the
 * renderer. The harness owns tool execution, context management, and writing the
 * session .jsonl; we just relay.
 *
 * The driver is the single source of truth for what is currently running. Each
 * spawned process is a "run" keyed by a stable `runId`, tracked in a registry
 * that survives renderer reloads. Runs are never implicitly killed by opening
 * another — concurrent runs across projects/harnesses are first-class — and the
 * renderer can resync at any time via `snapshot()`.
 */
export class AgentDriver {
  private runs = new Map<string, AgentSession>()
  private seq = 0

  constructor(private emit: (event: AgentEvent) => void) {}

  /**
   * Open (or reuse) a run for the given target. Resuming an existing session
   * reuses a live run for that sessionPath; a new chat reuses a live pathless
   * run for the same cwd. Otherwise a fresh process is spawned. Returns the
   * runId the caller should address subsequent sends/aborts to.
   */
  open(
    harness: HarnessConfig,
    cwd: string,
    sessionPath?: string
  ): { ok: boolean; reason?: string; runId?: string } {
    if (!harness.cli) {
      return { ok: false, reason: 'No RPC launcher resolved for this harness (view-only).' }
    }

    // Reuse a still-live run that targets the same session/cwd rather than
    // respawning a fresh process every prompt.
    const existing = this.findReusable(harness.id, cwd, sessionPath)
    if (existing) return { ok: true, runId: existing.runId }

    const args = ['--mode', 'rpc']
    if (sessionPath) args.push('--session', sessionPath)

    // The launcher is an executable bash script that sets up env and execs the
    // bundled cli.js, so spawn it directly. We prepend common node locations to
    // PATH because a GUI-launched Electron app may not inherit the user's shell
    // PATH (the launcher does `exec node …`).
    let child: ChildProcessWithoutNullStreams
    try {
      child = spawn(harness.cli, args, {
        cwd,
        env: { ...process.env, PATH: augmentedPath(process.env.PATH) },
        stdio: ['pipe', 'pipe', 'pipe']
      })
    } catch (err) {
      return { ok: false, reason: err instanceof Error ? err.message : 'spawn failed' }
    }

    const runId = `run-${++this.seq}-${Date.now().toString(36)}`
    const session = new AgentSession(
      runId,
      harness.id,
      cwd,
      child,
      sessionPath,
      this.emit,
      () => this.runs.delete(runId)
    )
    this.runs.set(runId, session)
    return { ok: true, runId }
  }

  send(runId: string, text: string): { ok: boolean; reason?: string } {
    const s = this.runs.get(runId)
    if (!s) return { ok: false, reason: 'No open agent run. Open one first.' }
    return s.send(text)
  }

  abort(runId: string): void {
    this.runs.get(runId)?.abort()
  }

  close(runId: string): void {
    const s = this.runs.get(runId)
    if (s) {
      s.dispose()
      this.runs.delete(runId)
    }
  }

  /** Close every run belonging to a harness (used when a harness is removed). */
  closeHarness(harnessId: string): void {
    for (const [id, s] of [...this.runs]) {
      if (s.harnessId === harnessId) {
        s.dispose()
        this.runs.delete(id)
      }
    }
  }

  /** Snapshot all live runs so the renderer can rebuild state after a reload. */
  snapshot(): RunSnapshot[] {
    return [...this.runs.values()].map((s) => s.snapshot())
  }

  disposeAll(): void {
    for (const id of [...this.runs.keys()]) this.close(id)
  }

  private findReusable(harnessId: string, cwd: string, sessionPath?: string): AgentSession | undefined {
    for (const s of this.runs.values()) {
      if (s.harnessId !== harnessId || !s.alive) continue
      if (sessionPath) {
        if (s.sessionPath && samePath(s.sessionPath, sessionPath)) return s
      } else if (!s.sessionPath && samePath(s.cwd, cwd)) {
        return s
      }
    }
    // Resume requested, but the only live run for this cwd is the brand-new chat
    // we just started (still pathless because we spawned it before the harness
    // wrote the .jsonl). Adopt the path onto it rather than spawning a duplicate
    // process for the same session.
    if (sessionPath) {
      for (const s of this.runs.values()) {
        if (s.harnessId === harnessId && s.alive && !s.sessionPath && samePath(s.cwd, cwd)) {
          s.sessionPath = sessionPath
          return s
        }
      }
    }
    return undefined
  }
}

const STREAM_TAIL_MAX = 32_000
const STDERR_TAIL_MAX = 8_000

class AgentSession {
  private rl: readline.Interface
  private child: ChildProcessWithoutNullStreams
  status: RunStatus = 'starting'
  private startedAt = Date.now()
  private currentTool: string | undefined
  private streamTail = ''
  private thinkingTail = ''
  private stderrTail = ''
  private errorReason: string | undefined
  private userAborted = false
  private finished = false
  private statePoll?: ReturnType<typeof setTimeout>

  constructor(
    readonly runId: string,
    readonly harnessId: string,
    readonly cwd: string,
    child: ChildProcessWithoutNullStreams,
    public sessionPath: string | undefined,
    private emit: (event: AgentEvent) => void,
    private onGone: () => void
  ) {
    this.child = child
    this.rl = readline.createInterface({ input: child.stdout })
    this.rl.on('line', (line) => this.onLine(line))

    child.stderr.on('data', (d) => {
      const text = String(d)
      this.stderrTail = clip(this.stderrTail + text, STDERR_TAIL_MAX)
      this.emitEvent('stderr', { delta: text })
    })

    // Abnormal-termination detection. A broken stdout pipe (`end`) without a
    // clean `agent_end`, or a non-zero/ signalled exit, is reported as an error
    // instead of silently going idle.
    child.stdout.on('end', () => this.onStreamEnd())
    child.stdin.on('error', (err) => this.fail(`stdin pipe error: ${err.message}`))
    child.on('error', (err) => this.fail(err.message))
    child.on('exit', (code, signal) => this.onExit(code, signal))

    // For a brand-new chat we spawned without a --session path, so we don't yet
    // know the file the harness created. Ask it (get_state → sessionFile) and
    // bind it as soon as it's known, so the session appears in the UI and is
    // selected immediately instead of waiting for the file watcher.
    if (!this.sessionPath) this.scheduleStatePoll()
  }

  get alive(): boolean {
    return !this.finished && this.child.exitCode === null && this.child.signalCode === null
  }

  private scheduleStatePoll(tries = 0): void {
    if (this.sessionPath || this.finished || tries > 30) return
    this.requestState()
    this.statePoll = setTimeout(() => this.scheduleStatePoll(tries + 1), 300)
  }

  private requestState(): void {
    try {
      this.child.stdin.write(JSON.stringify({ type: 'get_state' }) + '\n')
    } catch {
      // ignore
    }
  }

  /** Pull a session file path out of a get_state response (or any event carrying it). */
  private extractSessionFile(evt: Record<string, unknown>): string | undefined {
    const data = (evt.data ?? evt) as Record<string, unknown> | undefined
    const sf = data?.sessionFile
    return typeof sf === 'string' && sf ? sf : undefined
  }

  private onLine(line: string): void {
    const trimmed = line.trim()
    if (!trimmed) return
    let evt: Record<string, unknown>
    try {
      evt = JSON.parse(trimmed)
    } catch {
      return
    }
    const type = String(evt.type ?? 'unknown')
    if (this.status === 'starting') this.status = 'running'

    // Bind the session file once the harness reveals it AND it actually exists on
    // disk. get_state returns the path before the file is written (messageCount
    // 0), so we keep polling until the file is real — otherwise the renderer's
    // loadSession would fail and adoption would never happen.
    if (!this.sessionPath) {
      const sf = this.extractSessionFile(evt)
      if (sf && existsSync(sf)) {
        this.sessionPath = sf
        if (this.statePoll) clearTimeout(this.statePoll)
        this.emitEvent('session_bound', {})
      }
    }

    const { delta, thinkingDelta } = extractDeltas(evt)
    if (delta) this.streamTail = clip(this.streamTail + delta, STREAM_TAIL_MAX)
    if (thinkingDelta) this.thinkingTail = clip(this.thinkingTail + thinkingDelta, STREAM_TAIL_MAX)

    const toolName = typeof evt.toolName === 'string' ? evt.toolName : undefined
    if (toolName) this.currentTool = toolName

    // A clean end of turn: the process stays up for the next prompt, so the run
    // goes back to idle here. The renderer handles the brief "finalizing" hand-off
    // to the authoritative file reload on its side; reporting idle in our
    // snapshot keeps a focus-triggered resync from resurrecting a stale
    // "finalizing" state.
    if (type === 'agent_end') {
      this.status = 'idle'
      this.currentTool = undefined
      this.streamTail = ''
      this.thinkingTail = ''
    }

    this.emitEvent(type, { delta, thinkingDelta, toolName })
  }

  send(text: string): { ok: boolean; reason?: string } {
    if (!this.alive) return { ok: false, reason: 'Agent process is no longer running.' }
    try {
      this.child.stdin.write(JSON.stringify({ type: 'prompt', message: text }) + '\n')
      this.userAborted = false
      this.status = 'running'
      this.startedAt = Date.now()
      this.streamTail = ''
      this.thinkingTail = ''
      this.errorReason = undefined
      // The session file is created once a prompt is processed; (re)start polling
      // for its path if we don't have it yet.
      if (!this.sessionPath) this.scheduleStatePoll()
      return { ok: true }
    } catch (err) {
      return { ok: false, reason: err instanceof Error ? err.message : 'write failed' }
    }
  }

  abort(): void {
    this.userAborted = true
    this.status = 'idle'
    try {
      this.child.stdin.write(JSON.stringify({ type: 'abort' }) + '\n')
    } catch {
      // ignore
    }
  }

  snapshot(): RunSnapshot {
    return {
      runId: this.runId,
      harnessId: this.harnessId,
      cwd: this.cwd,
      sessionPath: this.sessionPath ?? null,
      status: this.status,
      currentTool: this.currentTool,
      startedAt: this.startedAt,
      streamTail: this.streamTail,
      thinkingTail: this.thinkingTail,
      error: this.errorReason
    }
  }

  dispose(): void {
    this.finished = true
    if (this.statePoll) clearTimeout(this.statePoll)
    this.rl.close()
    try {
      this.child.kill()
    } catch {
      // ignore
    }
  }

  private onStreamEnd(): void {
    // stdout closed. If the turn hadn't cleanly ended and the user didn't abort,
    // this is an abnormal disconnect. The `exit` handler will follow with the
    // code; we defer the verdict to it unless the process is already gone.
    if (this.child.exitCode !== null || this.child.signalCode !== null) {
      this.onExit(this.child.exitCode, this.child.signalCode)
    }
  }

  private onExit(code: number | null, signal: NodeJS.Signals | null): void {
    if (this.finished) return
    this.finished = true
    // Exiting while a turn is in flight (not user-aborted, not cleanly idle) is a
    // crash; report it. Exiting while idle/aborted is expected teardown.
    const abnormal = !this.userAborted && this.status !== 'idle'
    if (abnormal && (code == null || code !== 0 || signal)) {
      this.fail(
        signal
          ? `Agent process terminated (${signal}).`
          : `Agent process exited with code ${code ?? 'unknown'}.`,
        code,
        signal
      )
    } else {
      this.status = 'idle'
      this.emitEvent('agent_exit', { exitCode: code, signal: signal ?? undefined })
    }
    this.onGone()
  }

  private fail(reason: string, code?: number | null, signal?: NodeJS.Signals | null): void {
    if (this.status === 'error') return
    this.status = 'error'
    this.errorReason = reason
    this.finished = true
    this.emitEvent('error', {
      errorReason: reason,
      stderrTail: this.stderrTail.trim() || undefined,
      exitCode: code ?? this.child.exitCode,
      signal: signal ?? this.child.signalCode ?? undefined
    })
    this.onGone()
  }

  private emitEvent(type: string, extra: Partial<AgentEvent>): void {
    this.emit({
      runId: this.runId,
      harnessId: this.harnessId,
      cwd: this.cwd,
      sessionPath: this.sessionPath,
      type,
      ...extra
    })
  }
}

function clip(s: string, max: number): string {
  return s.length > max ? s.slice(s.length - max) : s
}

/** Normalized, trailing-slash-tolerant path equality. */
export function samePath(a: string, b: string): boolean {
  try {
    return path.resolve(a) === path.resolve(b)
  } catch {
    return a === b
  }
}

/** Ensure common node install locations are on PATH for the spawned launcher. */
function augmentedPath(current: string | undefined): string {
  const extra = ['/usr/local/bin', '/opt/homebrew/bin', `${process.env.HOME}/.hermes/node/bin`]
  const parts = (current ?? '').split(':').filter(Boolean)
  for (const p of extra) if (!parts.includes(p)) parts.push(p)
  return parts.join(':')
}

/**
 * Pull streaming deltas out of a message_update event. The harness emits two
 * delta streams via assistantMessageEvent: `text_delta` (visible answer) and
 * `thinking_delta` (reasoning). We separate them so the UI can render the
 * thinking in its own collapsible lane.
 */
function extractDeltas(evt: Record<string, unknown>): { delta?: string; thinkingDelta?: string } {
  const ame = evt.assistantMessageEvent as { type?: string; delta?: string } | undefined
  if (ame && typeof ame.delta === 'string') {
    if (ame.type === 'text_delta') return { delta: ame.delta }
    if (ame.type === 'thinking_delta') return { thinkingDelta: ame.delta }
    return {}
  }
  if (typeof evt.delta === 'string') return { delta: evt.delta }
  return {}
}
