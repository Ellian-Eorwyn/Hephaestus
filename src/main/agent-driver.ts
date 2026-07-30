import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import path from 'node:path'
import { existsSync } from 'node:fs'
import type {
  AgentBatch,
  AgentStreamEvent,
  BatchItem,
  ExtensionUIRequest,
  ExtensionUIResponse,
  HarnessConfig,
  RunSnapshot,
  RunStatus,
  StatsPatch,
  ToolArgsLike,
  Usage
} from '@shared/types'
import { augmentedPath } from './paths'
import { attachJsonlLineReader } from './jsonl'

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
 *
 * Stream activity is *batched*: deltas are coalesced on a short timer and sent
 * as one `AgentBatch` per frame, because one IPC message (and one React commit)
 * per token is what makes a fast local model feel slow.
 */
export class AgentDriver {
  private runs = new Map<string, AgentSession>()
  private seq = 0
  private reapTimer: ReturnType<typeof setInterval>

  constructor(private emit: (batch: AgentBatch) => void) {
    // Idle harness processes are kept warm for reuse, but not forever: without
    // this, one child per (harness, cwd) accumulates for the life of the app.
    this.reapTimer = setInterval(() => this.reapIdle(), REAP_SWEEP_MS)
    this.reapTimer.unref?.()
  }

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

    // The launcher is either a harness-local bash script (Forge/Vault) that sets
    // up its own env and execs the bundled cli.js, or a global binary like `pi`.
    // Either way we prepend common node locations to PATH because a GUI-launched
    // Electron app may not inherit the user's shell PATH. A global binary doesn't
    // set the harness's agent dir, so we inject `<NAME>_CODING_AGENT_DIR`
    // ourselves (harmless for base pi where it equals the default).
    let child: ChildProcessWithoutNullStreams
    try {
      child = spawn(harness.cli, args, {
        cwd,
        env: {
          ...process.env,
          ...agentDirEnv(harness),
          PATH: augmentedPath(process.env.PATH)
        },
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

  send(
    runId: string,
    text: string,
    behavior?: 'steer' | 'followUp'
  ): { ok: boolean; reason?: string } {
    const s = this.runs.get(runId)
    if (!s) return { ok: false, reason: 'No open agent run. Open one first.' }
    return s.send(text, behavior)
  }

  /** Answer an in-flight interactive prompt for a run (RPC extension_ui_response). */
  respond(runId: string, response: ExtensionUIResponse): void {
    this.runs.get(runId)?.respond(response)
  }

  abort(runId: string): void {
    this.runs.get(runId)?.abort()
  }

  abortRetry(runId: string): void {
    this.runs.get(runId)?.abortRetry()
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
    clearInterval(this.reapTimer)
    for (const id of [...this.runs.keys()]) this.close(id)
  }

  /** Retire harness processes that have sat idle long enough to not be worth keeping warm. */
  private reapIdle(): void {
    const now = Date.now()
    for (const [id, s] of [...this.runs]) {
      if (s.reapable(now)) {
        s.retire()
        this.runs.delete(id)
      }
    }
  }

  private findReusable(
    harnessId: string,
    cwd: string,
    sessionPath?: string
  ): AgentSession | undefined {
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
/** Coalescing window for stream deltas — roughly one flush per animation frame. */
const FLUSH_MS = 33
const REQUEST_TIMEOUT_MS = 10_000
/** Liveness probe cadence while a turn is in flight. */
const PING_INTERVAL_MS = 20_000
const PING_TIMEOUT_MS = 10_000
const SESSION_POLL_MS = 300
const SESSION_POLL_TRIES = 30
/** Abort escalation: ask nicely, then close stdin, then signal. */
const ABORT_STDIN_MS = 5_000
const ABORT_TERM_MS = 3_000
const ABORT_KILL_MS = 2_000
/** Grace period after stdout closes before we call a still-running process dead. */
const STREAM_END_GRACE_MS = 2_000
/** Delay before double-checking that a turn which ended mid-queue is really done. */
const SETTLE_CONFIRM_MS = 2_000
const REAP_SWEEP_MS = 60_000
const REAP_IDLE_MS = 10 * 60_000
/** Unified diffs from the `edit` tool are shown verbatim; cap pathological ones. */
const DIFF_MAX = 20_000
const TOOL_OUTPUT_MAX = 4_000

/**
 * Events that must not wait for the coalescing timer: anything the UI reacts to
 * as a state change rather than as text. Pending deltas ride along in the same
 * batch, so ordering is preserved.
 */
const URGENT: ReadonlySet<string> = new Set([
  'agent_end',
  'agent_exit',
  'error',
  'stream_error',
  'prompt_rejected',
  'session_bound',
  'extension_ui_request',
  'ui_cancelled',
  'unresponsive',
  'compaction_start',
  'compaction_end',
  'auto_retry_start',
  'auto_retry_end'
])

class AgentSession {
  private detachReader: () => void
  private child: ChildProcessWithoutNullStreams
  status: RunStatus = 'starting'
  private startedAt = Date.now()
  private lastActivityAt = Date.now()
  private currentTool: string | undefined
  private streamTail = ''
  private thinkingTail = ''
  private stderrTail = ''
  private errorReason: string | undefined
  private userAborted = false
  private finished = false
  private unresponsive = false
  private uiStatus: RunSnapshot['uiStatus']
  /** How many messages the harness is holding for later turns. */
  private queuedCount = 0
  private queued: RunSnapshot['queued']
  private phase: RunSnapshot['phase'] = null
  private retry: RunSnapshot['retry']
  /** A blocking interactive prompt the turn is paused on, awaiting our response. */
  private pendingUi: ExtensionUIRequest | null = null

  // --- request/response correlation -----------------------------------------
  private reqSeq = 0
  private pending = new Map<
    string,
    { resolve: (data: unknown) => void; reject: (err: Error) => void; timer: ReturnType<typeof setTimeout> }
  >()
  /** Ids of fire-and-forget commands whose failure we still want to surface. */
  private promptAcks = new Set<string>()

  // --- stats -----------------------------------------------------------------
  /** When the first token of the current assistant message arrived. */
  private msgFirstDeltaAt: number | null = null
  /** Whether the harness reported telemetry for the current message. */
  private msgSawTelemetry = false
  /** When the current turn began, for measuring time-to-first-token ourselves. */
  private turnStartedAt = 0
  /** This harness has no `get_session_stats`; stop asking. */
  private statsUnsupported = false

  // --- batching --------------------------------------------------------------
  private items: BatchItem[] = []
  private flushTimer: ReturnType<typeof setTimeout> | null = null
  private batchSeq = 0

  // --- timers ----------------------------------------------------------------
  private timers = new Set<ReturnType<typeof setTimeout>>()
  private abortTimers: ReturnType<typeof setTimeout>[] = []
  private uiTimer: ReturnType<typeof setTimeout> | null = null
  private pingTimer: ReturnType<typeof setInterval> | null = null
  private pingInFlight = false
  private pollingSession = false

  constructor(
    readonly runId: string,
    readonly harnessId: string,
    readonly cwd: string,
    child: ChildProcessWithoutNullStreams,
    public sessionPath: string | undefined,
    private emit: (batch: AgentBatch) => void,
    private onGone: () => void
  ) {
    this.child = child
    this.detachReader = attachJsonlLineReader(child.stdout, (line) => this.onLine(line))

    // stderr is diagnostics, never protocol: the harness rebinds stray stdout
    // writes to stderr precisely to keep the JSONL channel clean. Keep a ring
    // buffer to attach to error reports — but never treat it as stream text.
    child.stderr.on('data', (d) => {
      this.stderrTail = clip(this.stderrTail + String(d), STDERR_TAIL_MAX)
    })

    // Abnormal-termination detection. A broken stdout pipe (`end`) without a
    // clean `agent_end`, or a non-zero/ signalled exit, is reported as an error
    // instead of silently going idle.
    child.stdout.on('end', () => this.onStreamEnd())
    child.stdin.on('error', (err) => this.fail(`stdin pipe error: ${err.message}`))
    child.on('error', (err) => this.fail(err.message))
    child.on('exit', (code, signal) => this.onExit(code, signal))

    this.pingTimer = setInterval(() => this.pingIfStreaming(), PING_INTERVAL_MS)
    this.pingTimer.unref?.()

    // For a brand-new chat we spawned without a --session path, so we don't yet
    // know the file the harness created. Ask it (get_state → sessionFile) and
    // bind it as soon as it's known, so the session appears in the UI and is
    // selected immediately instead of waiting for the file watcher.
    if (!this.sessionPath) this.pollSessionFile()
  }

  get alive(): boolean {
    return !this.finished && this.child.exitCode === null && this.child.signalCode === null
  }

  /** Idle long enough that keeping the process warm isn't worth the memory. */
  reapable(now: number): boolean {
    return (
      this.alive &&
      this.status === 'idle' &&
      !this.pendingUi &&
      now - this.lastActivityAt > REAP_IDLE_MS
    )
  }

  // -------------------------------------------------------------------------
  // stdin
  // -------------------------------------------------------------------------

  private write(cmd: Record<string, unknown>): boolean {
    try {
      this.child.stdin.write(JSON.stringify(cmd) + '\n')
      return true
    } catch {
      return false
    }
  }

  /**
   * Issue a command and await its correlated response. The harness echoes our
   * `id` back on the single stdout channel, so responses are matched here and
   * never leak into the event stream.
   */
  private request(cmd: Record<string, unknown>, timeoutMs = REQUEST_TIMEOUT_MS): Promise<unknown> {
    return new Promise((resolve, reject) => {
      if (!this.alive) {
        reject(new Error('Agent process is no longer running.'))
        return
      }
      const id = `req-${++this.reqSeq}`
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new Error(`${String(cmd.type)} timed out`))
      }, timeoutMs)
      timer.unref?.()
      this.pending.set(id, { resolve, reject, timer })
      if (!this.write({ ...cmd, id })) {
        this.pending.delete(id)
        clearTimeout(timer)
        reject(new Error('write failed'))
      }
    })
  }

  send(text: string, behavior?: 'steer' | 'followUp'): { ok: boolean; reason?: string } {
    if (!this.alive) return { ok: false, reason: 'Agent process is no longer running.' }

    // pi *requires* a streamingBehavior when a turn is already in flight and
    // rejects the command otherwise — so a mid-stream prompt must say whether it
    // steers the current turn or queues as a follow-up.
    const midStream = this.status === 'running'
    const id = `ack-${++this.reqSeq}`
    const cmd: Record<string, unknown> = { type: 'prompt', message: text, id }
    if (midStream) cmd.streamingBehavior = behavior ?? 'followUp'

    this.promptAcks.add(id)
    if (!this.write(cmd)) {
      this.promptAcks.delete(id)
      return { ok: false, reason: 'write failed' }
    }

    // Only a fresh turn resets the live buffers. Doing this mid-stream would
    // discard the reply currently on screen.
    if (!midStream) {
      this.userAborted = false
      this.status = 'running'
      this.startedAt = Date.now()
      this.turnStartedAt = Date.now()
      this.streamTail = ''
      this.thinkingTail = ''
      this.errorReason = undefined
      this.msgFirstDeltaAt = null
      this.msgSawTelemetry = false
    }
    this.lastActivityAt = Date.now()

    // The session file is created once a prompt is processed; (re)start polling
    // for its path if we don't have it yet.
    if (!this.sessionPath) this.pollSessionFile()
    return { ok: true }
  }

  /**
   * Answer the in-flight interactive prompt by writing an extension_ui_response
   * on stdin (same channel as prompt/abort). The response is matched to the
   * pending request by its id; the harness's paused promise then resolves and
   * the turn continues.
   */
  respond(response: ExtensionUIResponse): void {
    const id = this.pendingUi?.id
    if (!id) return
    this.pendingUi = null
    this.clearUiTimer()
    this.write({ type: 'extension_ui_response', id, ...response })
  }

  /** Give up on a pending auto-retry rather than waiting out its backoff. */
  abortRetry(): void {
    this.write({ type: 'abort_retry' })
  }

  /**
   * Cancel the current turn. `abort` alone is the polite path and leaves the
   * process up for reuse — which is why the escalation ladder below only fires
   * if the harness never acknowledges with `agent_end`.
   */
  abort(): void {
    this.userAborted = true
    // Report idle straight away so a focus-triggered resync can't resurrect a
    // "running" state the user already cancelled.
    this.status = 'idle'
    this.pendingUi = null
    this.clearUiTimer()
    this.write({ type: 'abort' })

    this.clearAbortLadder()
    const step = (ms: number, fn: () => void): void => {
      const t = setTimeout(fn, ms)
      t.unref?.()
      this.abortTimers.push(t)
    }
    // The protocol has no shutdown command: closing stdin is its documented
    // clean exit. Signals are the last resort.
    step(ABORT_STDIN_MS, () => {
      if (this.alive) {
        try {
          this.child.stdin.end()
        } catch {
          // ignore — the exit handler reports the outcome
        }
      }
    })
    step(ABORT_STDIN_MS + ABORT_TERM_MS, () => {
      if (this.alive) this.kill('SIGTERM')
    })
    step(ABORT_STDIN_MS + ABORT_TERM_MS + ABORT_KILL_MS, () => {
      if (this.alive) this.kill('SIGKILL')
    })
  }

  // -------------------------------------------------------------------------
  // stdout
  // -------------------------------------------------------------------------

  private onLine(line: string): void {
    this.lastActivityAt = Date.now()
    // Any line at all proves the harness is alive.
    if (this.unresponsive) {
      this.unresponsive = false
      this.queueEvent({ type: 'responsive' })
    }

    let evt: Record<string, unknown>
    try {
      evt = JSON.parse(line)
    } catch {
      return
    }
    if (this.status === 'starting') this.status = 'running'

    if (evt.type === 'response') {
      this.onResponse(evt)
      return
    }
    this.onStreamLine(evt)
  }

  /** Command acks. These are correlated to a request and never forwarded as events. */
  private onResponse(evt: Record<string, unknown>): void {
    const id = typeof evt.id === 'string' ? evt.id : undefined
    const command = typeof evt.command === 'string' ? evt.command : 'command'
    const success = evt.success !== false
    const error = typeof evt.error === 'string' ? evt.error : `${command} failed`

    if (id) {
      const p = this.pending.get(id)
      if (p) {
        this.pending.delete(id)
        clearTimeout(p.timer)
        if (success) p.resolve(evt.data)
        else p.reject(new Error(error))
        return
      }
      if (this.promptAcks.delete(id)) {
        // A rejected prompt is the difference between "your message is queued"
        // and "your message vanished" — always surface it.
        if (!success) this.queueEvent({ type: 'prompt_rejected', reason: error })
        return
      }
    }
    // Unmatched. `parse` failures carry no id by design (they're unrecoverable).
    if (!success) this.queueEvent({ type: 'stream_error', reason: error })
  }

  /** Normalize a harness event into our typed stream and hand it to the batcher. */
  private onStreamLine(evt: Record<string, unknown>): void {
    const type = typeof evt.type === 'string' ? evt.type : ''

    switch (type) {
      case 'message_update': {
        const ame = asRecord(evt.assistantMessageEvent)
        // Telemetry can ride on the event itself or arrive as its own
        // assistantMessageEvent; take it from either.
        const telemetry = asRecord(evt.telemetry) ?? asRecord(ame?.telemetry)
        if (telemetry) this.absorbTelemetry(telemetry)

        const delta = str(ame?.delta)
        if (delta !== undefined) {
          if (ame?.type === 'text_delta') {
            this.markFirstDelta()
            this.queueText('text', delta)
          } else if (ame?.type === 'thinking_delta') {
            this.markFirstDelta()
            this.queueText('thinking', delta)
          }
          // Anything else carrying a delta (tool-call argument streaming) is not
          // shown, so it must not become renderer traffic.
          return
        }
        if (ame?.type === 'error') {
          this.queueEvent({ type: 'stream_error', reason: 'The model stream failed.' })
          return
        }
        // Older/other shapes put the delta at the top level.
        const top = str(evt.delta)
        if (top !== undefined) {
          this.markFirstDelta()
          this.queueText('text', top)
        }
        return
      }

      case 'message_start':
        // A new assistant message: restart per-message throughput measurement.
        this.msgFirstDeltaAt = null
        this.msgSawTelemetry = false
        this.queueEvent({ type: 'message_start', role: str(asRecord(evt.message)?.role) })
        return

      case 'message_end': {
        const msg = asRecord(evt.message)
        const usage = msg?.usage as Usage | undefined
        this.queueEvent({
          type: 'message_end',
          usage,
          stopReason: str(msg?.stopReason),
          model: str(msg?.model) ?? str(msg?.responseModel)
        })
        this.emitMessageStats(usage)
        return
      }

      case 'tool_execution_start':
        this.queueEvent({
          type: 'tool_execution_start',
          toolCallId: str(evt.toolCallId) ?? '',
          toolName: str(evt.toolName) ?? 'tool',
          args: asRecord(evt.args) as ToolArgsLike | undefined
        })
        return

      case 'tool_execution_update':
        this.queueEvent({
          type: 'tool_execution_update',
          toolCallId: str(evt.toolCallId) ?? '',
          toolName: str(evt.toolName) ?? 'tool',
          partialResult: toolOutputText(evt.partialResult)
        })
        return

      case 'tool_execution_end': {
        // `edit` hands us a ready-made unified diff; nothing else does.
        const details = asRecord(asRecord(evt.result)?.details)
        this.queueEvent({
          type: 'tool_execution_end',
          toolCallId: str(evt.toolCallId) ?? '',
          toolName: str(evt.toolName) ?? 'tool',
          isError: evt.isError === true,
          diff: clipEnd(str(details?.diff), DIFF_MAX)
        })
        return
      }

      case 'agent_start':
      case 'agent_settled':
      case 'turn_start':
      case 'turn_end':
        this.queueEvent({ type } as AgentStreamEvent)
        return

      case 'agent_end':
        this.queueEvent({ type: 'agent_end', willRetry: evt.willRetry === true })
        // Fetch authoritative totals. This resolves after the batch above has
        // gone out, so it arrives as its own later batch.
        this.requestSessionStats()
        return

      case 'queue_update':
        this.queueEvent({
          type: 'queue_update',
          steering: strArray(evt.steering),
          followUp: strArray(evt.followUp)
        })
        return

      case 'compaction_start':
        this.queueEvent({ type: 'compaction_start', reason: str(evt.reason) ?? 'threshold' })
        return

      case 'compaction_end':
        this.queueEvent({
          type: 'compaction_end',
          aborted: evt.aborted === true,
          errorMessage: str(evt.errorMessage)
        })
        return

      case 'auto_retry_start':
        this.queueEvent({
          type: 'auto_retry_start',
          attempt: num(evt.attempt) ?? 1,
          maxAttempts: num(evt.maxAttempts) ?? 1,
          delayMs: num(evt.delayMs) ?? 0,
          errorMessage: str(evt.errorMessage) ?? 'Request failed.'
        })
        return

      case 'auto_retry_end':
        this.queueEvent({
          type: 'auto_retry_end',
          success: evt.success === true,
          finalError: str(evt.finalError)
        })
        return

      case 'session_info_changed':
        this.queueEvent({ type: 'session_info_changed', name: str(evt.name) })
        return

      case 'extension_ui_request': {
        const ui = parseUiRequest(evt)
        if (ui) {
          this.queueEvent({ type: 'extension_ui_request', ui })
          return
        }
        const status = parseUiStatus(evt)
        if (status) this.queueEvent(status)
        return
      }

      case 'extension_error':
        this.queueEvent({
          type: 'stream_error',
          reason: `Extension error${str(evt.extensionPath) ? ` in ${str(evt.extensionPath)}` : ''}: ${
            str(evt.error) ?? 'unknown'
          }`
        })
        return

      default:
        // Unknown/uninteresting event types are dropped rather than forwarded —
        // a passthrough is how display-only chatter used to resurrect dead runs.
        return
    }
  }

  // -------------------------------------------------------------------------
  // Batching
  // -------------------------------------------------------------------------

  // -------------------------------------------------------------------------
  // Stats
  // -------------------------------------------------------------------------

  /** Note when the first visible/reasoning token of a message arrived. */
  private markFirstDelta(): void {
    if (this.msgFirstDeltaAt === null) this.msgFirstDeltaAt = Date.now()
  }

  /**
   * Provider-reported throughput (pi-forge's `StreamTelemetry`). When this is
   * present it wins outright — it's the real figure from the inference server,
   * including speculative-decode acceptance, which we could never infer.
   */
  private absorbTelemetry(t: Record<string, unknown>): void {
    this.msgSawTelemetry = true
    const throughput = asRecord(t.throughput)
    const speculative = asRecord(t.speculative)
    const usage = asRecord(t.usage)
    const patch: StatsPatch = { approx: false }
    const tps = num(throughput?.outputTokensPerSecond)
    if (tps !== undefined) patch.tokPerSec = tps
    const ttft = num(throughput?.timeToFirstTokenMs)
    if (ttft !== undefined) patch.ttftMs = ttft
    const rate = num(speculative?.acceptanceRate)
    if (rate !== undefined) patch.acceptanceRate = rate
    // The provider may flag its own numbers as estimated.
    if (throughput?.estimated === true) patch.approx = true
    if (usage) {
      patch.usage = {
        input: num(usage.input) ?? 0,
        output: num(usage.output) ?? 0,
        cacheRead: num(usage.cacheRead) ?? 0,
        cacheWrite: num(usage.cacheWrite) ?? 0,
        totalTokens: num(usage.totalTokens) ?? 0
      }
    }
    this.queueStats(patch)
  }

  /**
   * End of an assistant message. Always report its usage/cost; supply measured
   * throughput only when the harness didn't report any, so a harness without
   * telemetry still shows a rate (marked approximate) instead of nothing.
   */
  private emitMessageStats(usage: Usage | undefined): void {
    const patch: StatsPatch = {}
    if (usage) {
      patch.usage = usage
      const cost = num(usage.cost?.total)
      if (cost !== undefined) patch.cost = cost
    }
    if (!this.msgSawTelemetry && usage?.output && this.msgFirstDeltaAt !== null) {
      const seconds = Math.max(0.05, (Date.now() - this.msgFirstDeltaAt) / 1000)
      patch.tokPerSec = usage.output / seconds
      patch.approx = true
      // Measured from the turn starting to the first token appearing.
      if (this.turnStartedAt) patch.ttftMs = this.msgFirstDeltaAt - this.turnStartedAt
    }
    if (Object.keys(patch).length) this.queueStats(patch)
    this.msgFirstDeltaAt = null
    this.msgSawTelemetry = false
  }

  /**
   * Authoritative totals at end of turn. Also the only source of the harness's own
   * context-window accounting, which beats our client-side estimate. A harness that
   * doesn't support the command is asked exactly once.
   */
  private requestSessionStats(): void {
    if (this.statsUnsupported || !this.alive) return
    void this.request({ type: 'get_session_stats' }, 8_000)
      .then((data) => {
        const d = asRecord(data)
        if (!d) return
        const tokens = asRecord(d.tokens)
        const ctx = asRecord(d.contextUsage)
        const patch: StatsPatch = { final: true }
        const cost = num(d.cost)
        if (cost !== undefined) patch.cost = cost
        if (tokens) {
          patch.usage = {
            input: num(tokens.input) ?? 0,
            output: num(tokens.output) ?? 0,
            cacheRead: num(tokens.cacheRead) ?? 0,
            cacheWrite: num(tokens.cacheWrite) ?? 0,
            totalTokens: num(tokens.total) ?? 0
          }
        }
        // contextUsage is optional, and null right after a compaction.
        if (ctx) {
          const t = num(ctx.tokens)
          const w = num(ctx.contextWindow)
          const p = num(ctx.percent)
          if (t !== undefined) patch.contextTokens = t
          if (w !== undefined) patch.contextWindow = w
          if (p !== undefined) patch.contextPercent = p
        }
        this.queueStats(patch)
        this.flush()
      })
      .catch(() => {
        // Older harness, or the turn's process went away — don't keep asking.
        this.statsUnsupported = true
      })
  }

  /**
   * Safety net for staying `running` after a turn ended with messages still
   * queued: ask the harness whether it is actually still working. Without this, a
   * harness that never emits `agent_settled` (pre-0.80) and whose queue reading we
   * got wrong would leave the run streaming forever.
   */
  private confirmSettledSoon(): void {
    this.later(() => {
      if (this.finished || this.status !== 'running') return
      void this.request({ type: 'get_state' }, PING_TIMEOUT_MS)
        .then((data) => {
          const d = asRecord(data)
          if (!d || this.finished || this.status !== 'running') return
          const busy = d.isStreaming === true || (num(d.pendingMessageCount) ?? 0) > 0
          if (busy) return
          // Nothing in flight and nothing queued: the work really is done.
          this.queuedCount = 0
          this.queued = { steering: [], followUp: [] }
          this.queueEvent({ type: 'agent_settled' }, true)
        })
        .catch(() => undefined)
    }, SETTLE_CONFIRM_MS)
  }

  /** Queue a stats update, merging into one already pending for this flush. */
  private queueStats(patch: StatsPatch): void {
    for (let i = this.items.length - 1; i >= 0; i--) {
      const it = this.items[i]
      if (it.kind === 'event' && it.event.type === 'stats') {
        it.event.patch = { ...it.event.patch, ...patch }
        this.arm()
        return
      }
    }
    this.items.push({ kind: 'event', event: { type: 'stats', patch } })
    this.arm()
  }

  private queueText(kind: 'text' | 'thinking', text: string): void {
    if (!text) return
    const last = this.items[this.items.length - 1]
    if (last && last.kind === kind) last.text += text
    else this.items.push({ kind, text })
    this.arm()
  }

  private queueEvent(event: AgentStreamEvent, urgent = false): void {
    this.items.push({ kind: 'event', event })
    if (urgent || URGENT.has(event.type)) this.flush()
    else this.arm()
  }

  private arm(): void {
    if (this.flushTimer) return
    this.flushTimer = setTimeout(() => this.flush(), FLUSH_MS)
    this.flushTimer.unref?.()
  }

  /**
   * Send one batch. Snapshot state is folded in here, walking items in order, so
   * an `agent_end` that clears the tails can't be undone by deltas queued in the
   * same window.
   */
  private flush(): void {
    if (this.flushTimer) {
      clearTimeout(this.flushTimer)
      this.flushTimer = null
    }
    if (!this.items.length) return
    const items = this.items
    this.items = []

    for (const it of items) {
      if (it.kind === 'text') this.streamTail = clip(this.streamTail + it.text, STREAM_TAIL_MAX)
      else if (it.kind === 'thinking')
        this.thinkingTail = clip(this.thinkingTail + it.text, STREAM_TAIL_MAX)
      else this.applyEventToState(it.event)
    }

    this.emit({
      runId: this.runId,
      harnessId: this.harnessId,
      cwd: this.cwd,
      sessionPath: this.sessionPath,
      seq: ++this.batchSeq,
      items
    })
  }

  private applyEventToState(e: AgentStreamEvent): void {
    switch (e.type) {
      case 'tool_execution_start':
        this.currentTool = e.toolName
        break
      case 'tool_execution_end':
        if (this.currentTool === e.toolName) this.currentTool = undefined
        break
      case 'agent_end':
        this.currentTool = undefined
        this.pendingUi = null
        this.phase = null
        this.clearUiTimer()
        // Whatever we were escalating has been honored.
        this.clearAbortLadder()
        // Queued work usually continues inside the same agent loop, so one
        // `agent_end` covers the lot. But if the harness ends a turn while still
        // holding messages, this isn't the end of the work: reporting idle would
        // let the next prompt be treated as a fresh turn (clobbering the live
        // buffers) and make the run reapable while the harness is still busy.
        if (this.queuedCount === 0) this.status = 'idle'
        else this.confirmSettledSoon()
        // Either way the previous turn's text is now on disk; the next turn starts
        // from an empty buffer.
        this.streamTail = ''
        this.thinkingTail = ''
        break

      case 'agent_settled':
        // Nothing left queued: the agent is genuinely done.
        this.status = 'idle'
        this.queuedCount = 0
        this.phase = null
        this.retry = undefined
        break

      case 'queue_update':
        this.queuedCount = e.steering.length + e.followUp.length
        this.queued = { steering: e.steering, followUp: e.followUp }
        break

      case 'compaction_start':
        this.phase = 'compacting'
        break

      case 'compaction_end':
        this.phase = null
        break

      case 'auto_retry_start':
        this.phase = 'retrying'
        this.retry = {
          attempt: e.attempt,
          maxAttempts: e.maxAttempts,
          delayMs: e.delayMs,
          startedAt: Date.now(),
          errorMessage: e.errorMessage
        }
        break

      case 'auto_retry_end':
        this.phase = null
        this.retry = undefined
        break
      case 'extension_ui_request':
        // Blocking methods are retained so a reconnecting renderer can restore
        // the prompt; `notify` is fire-and-forget.
        if (e.ui.method !== 'notify') {
          this.pendingUi = e.ui
          this.armUiTimeout(e.ui)
        }
        break
      case 'ui_cancelled':
        this.pendingUi = null
        break
      case 'ui_status': {
        const next = { ...(this.uiStatus ?? {}) }
        if ('status' in e) next.status = e.status
        if ('title' in e) next.title = e.title
        if ('widget' in e) next.widget = e.widget
        this.uiStatus = next
        break
      }
      default:
        break
    }
  }

  // -------------------------------------------------------------------------
  // Session binding + liveness
  // -------------------------------------------------------------------------

  /**
   * Poll `get_state` until the harness reveals the session file it created (and
   * that file actually exists — get_state reports the path before the first
   * write, and binding early would make the renderer's loadSession fail).
   */
  private pollSessionFile(): void {
    if (this.pollingSession || this.sessionPath || this.finished) return
    this.pollingSession = true

    const attempt = (tries: number): void => {
      if (this.sessionPath || this.finished || tries > SESSION_POLL_TRIES) {
        this.pollingSession = false
        return
      }
      void this.request({ type: 'get_state' }, PING_TIMEOUT_MS)
        .then((data) => this.bindSessionFile(data))
        .catch(() => undefined)
        .then(() => {
          if (this.sessionPath || this.finished) {
            this.pollingSession = false
            return
          }
          this.later(() => attempt(tries + 1), SESSION_POLL_MS)
        })
    }
    attempt(0)
  }

  private bindSessionFile(data: unknown): void {
    if (this.sessionPath) return
    const sf = str(asRecord(data)?.sessionFile)
    if (!sf || !existsSync(sf)) return
    this.sessionPath = sf
    this.queueEvent({ type: 'session_bound', sessionPath: sf })
  }

  /**
   * A wedged harness looks exactly like a long silent tool call, so silence
   * alone proves nothing. `get_state` answers even mid-stream — an unanswered
   * one is real evidence.
   */
  private pingIfStreaming(): void {
    if (this.finished || this.status !== 'running' || this.pingInFlight) return
    this.pingInFlight = true
    void this.request({ type: 'get_state' }, PING_TIMEOUT_MS)
      .then((data) => {
        if (this.unresponsive) {
          this.unresponsive = false
          this.queueEvent({ type: 'responsive' })
        }
        this.bindSessionFile(data)
      })
      .catch(() => {
        if (this.finished || this.unresponsive) return
        this.unresponsive = true
        this.queueEvent({ type: 'unresponsive' })
      })
      .then(() => {
        this.pingInFlight = false
      })
  }

  /**
   * The harness resolves its own dialog timeouts, so this only clears the card
   * we're showing for a prompt that can no longer be answered.
   */
  private armUiTimeout(ui: ExtensionUIRequest): void {
    this.clearUiTimer()
    const ms = 'timeout' in ui && typeof ui.timeout === 'number' ? ui.timeout : 0
    if (!ms || ms <= 0) return
    this.uiTimer = setTimeout(() => {
      this.uiTimer = null
      if (this.pendingUi?.id !== ui.id) return
      this.queueEvent({ type: 'ui_cancelled', id: ui.id })
    }, ms + 250)
    this.uiTimer.unref?.()
  }

  private clearUiTimer(): void {
    if (this.uiTimer) {
      clearTimeout(this.uiTimer)
      this.uiTimer = null
    }
  }

  private clearAbortLadder(): void {
    for (const t of this.abortTimers) clearTimeout(t)
    this.abortTimers = []
  }

  private later(fn: () => void, ms: number): void {
    const t = setTimeout(() => {
      this.timers.delete(t)
      fn()
    }, ms)
    t.unref?.()
    this.timers.add(t)
  }

  // -------------------------------------------------------------------------
  // Lifecycle
  // -------------------------------------------------------------------------

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
      error: this.errorReason,
      pendingUi: this.pendingUi,
      unresponsive: this.unresponsive || undefined,
      uiStatus: this.uiStatus,
      queued: this.queued,
      phase: this.phase,
      retry: this.retry
    }
  }

  /** Reaped for idleness: tell the renderer before going away. */
  retire(): void {
    if (!this.finished) {
      this.queueEvent({ type: 'agent_exit', exitCode: null }, true)
    }
    this.dispose()
  }

  dispose(): void {
    this.finished = true
    this.teardownTimers()
    this.detachReader()
    this.rejectPending('Agent run closed.')
    // Prefer the protocol's clean exit (stdin EOF) over a signal, but don't wait
    // forever for a process that ignores it.
    try {
      this.child.stdin.end()
    } catch {
      // ignore
    }
    const term = setTimeout(() => {
      if (this.child.exitCode === null && this.child.signalCode === null) this.kill('SIGTERM')
    }, ABORT_TERM_MS)
    const kill = setTimeout(() => {
      if (this.child.exitCode === null && this.child.signalCode === null) this.kill('SIGKILL')
    }, ABORT_TERM_MS + ABORT_KILL_MS)
    term.unref?.()
    kill.unref?.()
  }

  private teardownTimers(): void {
    if (this.flushTimer) {
      clearTimeout(this.flushTimer)
      this.flushTimer = null
    }
    for (const t of this.timers) clearTimeout(t)
    this.timers.clear()
    this.clearAbortLadder()
    this.clearUiTimer()
    if (this.pingTimer) {
      clearInterval(this.pingTimer)
      this.pingTimer = null
    }
  }

  private rejectPending(reason: string): void {
    for (const [, p] of this.pending) {
      clearTimeout(p.timer)
      p.reject(new Error(reason))
    }
    this.pending.clear()
    this.promptAcks.clear()
  }

  private kill(signal: NodeJS.Signals): void {
    try {
      this.child.kill(signal)
    } catch {
      // ignore
    }
  }

  private onStreamEnd(): void {
    // stdout closed. If the turn hadn't cleanly ended and the user didn't abort,
    // this is an abnormal disconnect. The `exit` handler usually follows with a
    // code — but a process that closes stdout and then hangs would leave the run
    // "running" forever, so don't wait indefinitely for it.
    if (this.child.exitCode !== null || this.child.signalCode !== null) {
      this.onExit(this.child.exitCode, this.child.signalCode)
      return
    }
    this.later(() => {
      if (this.finished) return
      if (this.child.exitCode !== null || this.child.signalCode !== null) {
        this.onExit(this.child.exitCode, this.child.signalCode)
      } else {
        this.fail('Agent closed its output stream but did not exit.')
      }
    }, STREAM_END_GRACE_MS)
  }

  private onExit(code: number | null, signal: NodeJS.Signals | null): void {
    if (this.finished) return
    this.finished = true
    this.teardownTimers()
    this.rejectPending('Agent process exited.')
    // The process is gone; any prompt it was blocked on can never be answered.
    this.pendingUi = null
    // Exiting while a turn is in flight (not user-aborted, not cleanly idle) is a
    // crash; report it. Exiting while idle/aborted is expected teardown.
    const abnormal = !this.userAborted && this.status !== 'idle'
    if (abnormal && (code == null || code !== 0 || signal)) {
      this.emitFailure(
        signal
          ? `Agent process terminated (${signal}).`
          : `Agent process exited with code ${code ?? 'unknown'}.`,
        code,
        signal
      )
    } else {
      this.status = 'idle'
      this.queueEvent({ type: 'agent_exit', exitCode: code, signal: signal ?? undefined }, true)
    }
    this.onGone()
  }

  private fail(reason: string): void {
    if (this.status === 'error' || this.finished) return
    this.finished = true
    this.teardownTimers()
    this.rejectPending(reason)
    this.emitFailure(reason, this.child.exitCode, this.child.signalCode)
    this.onGone()
  }

  private emitFailure(
    reason: string,
    code?: number | null,
    signal?: NodeJS.Signals | null
  ): void {
    this.status = 'error'
    this.errorReason = reason
    this.pendingUi = null
    this.queueEvent(
      {
        type: 'error',
        errorReason: reason,
        stderrTail: this.stderrTail.trim() || undefined,
        exitCode: code ?? null,
        signal: signal ?? undefined
      },
      true
    )
  }
}

function clip(s: string, max: number): string {
  return s.length > max ? s.slice(s.length - max) : s
}

/** Clip from the end (for diffs/output, where the head is the useful part). */
function clipEnd(s: string | undefined, max: number): string | undefined {
  if (s === undefined) return undefined
  return s.length > max ? `${s.slice(0, max)}\n… truncated` : s
}

function str(v: unknown): string | undefined {
  return typeof v === 'string' && v ? v : undefined
}

function num(v: unknown): number | undefined {
  return typeof v === 'number' && Number.isFinite(v) ? v : undefined
}

function asRecord(v: unknown): Record<string, unknown> | undefined {
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : undefined
}

function strArray(v: unknown): string[] {
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []
}

/**
 * Tool results are `any` in the protocol. Bash streams a cumulative snapshot;
 * others return content blocks. Pull out something printable, or nothing.
 */
function toolOutputText(result: unknown): string | undefined {
  if (typeof result === 'string') return clipEnd(result, TOOL_OUTPUT_MAX)
  const rec = asRecord(result)
  if (!rec) return undefined
  if (typeof rec.output === 'string') return clipEnd(rec.output, TOOL_OUTPUT_MAX)
  if (Array.isArray(rec.content)) {
    const text = rec.content
      .map((b) => str(asRecord(b)?.text) ?? '')
      .filter(Boolean)
      .join('')
    return text ? clipEnd(text, TOOL_OUTPUT_MAX) : undefined
  }
  return undefined
}

/**
 * Validate an extension_ui_request line into a typed request for the methods
 * that need an answer (blocking prompts + notify). Display-only methods are
 * handled by `parseUiStatus`.
 */
function parseUiRequest(evt: Record<string, unknown>): ExtensionUIRequest | undefined {
  const id = str(evt.id)
  const method = str(evt.method)
  if (!id || !method) return undefined
  const text = (v: unknown): string => str(v) ?? ''
  const timeout = num(evt.timeout)
  switch (method) {
    case 'select':
      return {
        id,
        method,
        title: text(evt.title),
        options: Array.isArray(evt.options) ? evt.options.map(String) : [],
        timeout
      }
    case 'confirm':
      return { id, method, title: text(evt.title), message: text(evt.message), timeout }
    case 'input':
      return { id, method, title: text(evt.title), placeholder: str(evt.placeholder), timeout }
    case 'editor':
      return { id, method, title: text(evt.title), prefill: str(evt.prefill) }
    case 'notify': {
      const nt = evt.notifyType
      return {
        id,
        method,
        message: text(evt.message),
        notifyType: nt === 'info' || nt === 'warning' || nt === 'error' ? nt : undefined
      }
    }
    default:
      return undefined
  }
}

/**
 * Display-only UI calls (`setStatus`/`setWidget`/`setTitle`). The harness keys
 * these per extension; we show a single slot, so the latest write wins and an
 * explicit `undefined` clears it. These never block a turn and must never be
 * mistaken for agent work.
 */
function parseUiStatus(evt: Record<string, unknown>): AgentStreamEvent | undefined {
  switch (str(evt.method)) {
    case 'setStatus':
      return { type: 'ui_status', status: str(evt.statusText) }
    case 'setWidget':
      return { type: 'ui_status', widget: strArray(evt.widgetLines) }
    case 'setTitle':
      return { type: 'ui_status', title: str(evt.title) }
    default:
      // `set_editor_text` and anything else display-only: nothing to show.
      return undefined
  }
}

/** Normalized, trailing-slash-tolerant path equality. */
export function samePath(a: string, b: string): boolean {
  try {
    return path.resolve(a) === path.resolve(b)
  } catch {
    return a === b
  }
}

/**
 * When the resolved launcher is a global binary (lives outside the harness
 * root, e.g. `~/.hermes/node/bin/pi` for a `~/.pi` harness) it won't set the
 * harness's agent dir, so it would default to `~/.pi/agent` regardless. Inject
 * `<NAME>_CODING_AGENT_DIR` matching pi's own `ENV_AGENT_DIR` convention. A
 * harness-local `bin/` wrapper sets this itself, so we skip it there.
 */
function agentDirEnv(harness: HarnessConfig): Record<string, string> {
  if (!harness.cli) return {}
  const harnessRoot = path.dirname(harness.agentDir)
  if (harness.cli.startsWith(harnessRoot + path.sep)) return {}
  const name = path.basename(harnessRoot).replace(/^\./, '')
  if (!name) return {}
  const key = `${name.toUpperCase().replace(/[^A-Z0-9]/g, '_')}_CODING_AGENT_DIR`
  return { [key]: harness.agentDir }
}
