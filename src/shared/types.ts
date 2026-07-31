// Shared domain + IPC types for Hephaestus.
// These mirror the pi/forge harness on-disk session format and config.

// ---------------------------------------------------------------------------
// Harness registry
// ---------------------------------------------------------------------------

export interface HarnessConfig {
  /** Stable id, e.g. "forge" | "vault". */
  id: string
  /** Display label shown in the top nav, e.g. "Forge". */
  label: string
  /** Absolute path to the harness `agent/` directory. */
  agentDir: string
  /** Resolved CLI launcher used for `--mode rpc`, or null if unresolved. */
  cli: string | null
}

// ---------------------------------------------------------------------------
// models.json / settings.json
// ---------------------------------------------------------------------------

export interface ModelCost {
  input: number
  output: number
  cacheRead: number
  cacheWrite: number
  total?: number
}

export interface HarnessModel {
  id: string
  name: string
  reasoning?: boolean
  input?: string[]
  contextWindow: number
  maxTokens: number
  cost: ModelCost
}

export interface HarnessProvider {
  name?: string
  baseUrl: string
  api: string
  apiKey: string
  models: HarnessModel[]
}

export interface ModelsConfig {
  providers: Record<string, HarnessProvider>
}

export interface HarnessSettings {
  packages?: string[]
  defaultProvider?: string
  defaultModel?: string
  theme?: string
  contextBudget?: {
    enabled?: boolean
    softRatio?: number
    verbatimRecentTokens?: number
  }
  compaction?: {
    enabled?: boolean
    reserveTokens?: number
  }
}

// ---------------------------------------------------------------------------
// Session records (raw JSONL line shapes) + normalized thread
// ---------------------------------------------------------------------------

export interface Usage {
  input: number
  output: number
  cacheRead: number
  cacheWrite: number
  totalTokens: number
  cost?: ModelCost
}

export type ContentBlock =
  | { type: 'text'; text: string }
  | { type: 'thinking'; thinking: string; thinkingSignature?: string }
  | { type: 'toolCall'; id: string; name: string; arguments: unknown }
  | { type: string; [k: string]: unknown }

export interface RawMessage {
  role: 'user' | 'assistant' | 'toolResult'
  content: ContentBlock[]
  // assistant-only
  usage?: Usage
  api?: string
  provider?: string
  model?: string
  responseModel?: string
  stopReason?: string
  // toolResult-only
  toolCallId?: string
  toolName?: string
  isError?: boolean
  timestamp?: number
}

/** A single JSONL record. `type` discriminates; unknown types are tolerated. */
export interface SessionRecord {
  type:
    | 'session'
    | 'model_change'
    | 'thinking_level_change'
    | 'message'
    | 'compaction'
    | 'custom_message'
    | 'branch_summary'
    | string
  id?: string
  parentId?: string | null
  timestamp?: string
  // session header
  version?: number
  cwd?: string
  parentSession?: string
  // model_change
  provider?: string
  modelId?: string
  // thinking_level_change
  thinkingLevel?: string
  // message
  message?: RawMessage
}

/** Normalized message for the UI (one per turn in the leaf thread). */
export interface ThreadMessage {
  id: string
  role: 'user' | 'assistant' | 'toolResult' | 'system'
  timestamp?: string
  text?: string
  thinking?: string
  toolCalls?: { id: string; name: string; arguments: unknown }[]
  toolResult?: { toolCallId?: string; toolName?: string; isError?: boolean; text: string }
  usage?: Usage
  model?: string
  /** Absolute path of a file the user was viewing when they sent this message. */
  attachedFile?: string
  /** Output tokens for this assistant turn (from usage), surfaced for the stats line. */
  outputTokens?: number
  /** Effective output tokens/sec for this turn (output ÷ response time), when derivable. */
  tps?: number
  /** True when `tps` is an estimate rather than a provider-reported figure. */
  tpsApprox?: boolean
}

export interface SessionSummary {
  /** Absolute path to the .jsonl file. */
  path: string
  /** Session id from the header line. */
  id: string
  timestamp: string
  /** First user message (truncated) used as a title. */
  title: string
  messageCount: number
  totalTokens: number
  /** Authoritative working dir from the session header (preferred over the folder name). */
  cwd?: string
}

/**
 * A session file changed on disk. Carries the freshly-computed summary so the
 * renderer can patch the one row that changed instead of re-listing (and
 * re-parsing) every session of every project in the harness.
 */
export interface SessionUpdatePayload {
  harnessId: string
  /** Absolute path to the .jsonl that changed. */
  path: string
  /** Encoded project folder name (the basename of the file's directory). */
  projectEncoded: string
  /** Fresh summary, or null if the file became unreadable. */
  summary: SessionSummary | null
  /** True when this file wasn't previously known — the sidebar may need a new row. */
  isNew: boolean
}

export interface ProjectSummary {
  /** Decoded working directory. */
  cwd: string
  /** Last path segment, used as the display name. */
  name: string
  /** Encoded folder name as stored under sessions/. */
  encoded: string
  sessions: SessionSummary[]
}

export interface SessionDetail {
  path: string
  header: SessionRecord
  /** Session name, when the harness has set one (`session_info_changed`). */
  name?: string
  messages: ThreadMessage[]
  usage: UsageTotals
  /** Last assistant message's model context window, for the context gauge. */
  contextWindow: number | null
  /** Estimated current-context tokens (last assistant input+output, or total). */
  currentContextTokens: number
}

export interface UsageTotals {
  input: number
  output: number
  cacheRead: number
  cacheWrite: number
  totalTokens: number
  cost: number
}

// ---------------------------------------------------------------------------
// File browser / preview
// ---------------------------------------------------------------------------

/**
 * One entry in the file browser.
 *
 * Directories are listed lazily: a `dir` node arrives with `children` undefined and
 * `loaded` false, and its contents are fetched only when the row is expanded. The
 * tree used to be walked eagerly to depth 8 on every project/chat click, which
 * froze the app outright for projects rooted at large or network-backed folders.
 */
export interface FileNode {
  name: string
  path: string
  type: 'file' | 'dir'
  children?: FileNode[]
  /** dir only: children have been fetched (an empty dir is `loaded` with `children: []`). */
  loaded?: boolean
  /** dir only: a cheap hint for whether expanding is worthwhile. */
  hasChildren?: boolean
  /** dir only: the listing hit the per-directory entry cap, so it is incomplete. */
  truncated?: boolean
}

/** Result of listing one directory level. */
export interface DirListing {
  path: string
  nodes: FileNode[]
  truncated: boolean
}

/**
 * A bounded, flat list of paths under a project, used to recognise file references
 * in the agent's replies. Separate from the visible tree, which is loaded lazily and
 * so only knows the levels that happen to be expanded.
 */
export interface PathIndex {
  cwd: string
  paths: string[]
  /** False when the walk stopped at its node cap or time budget. */
  complete: boolean
}

/**
 * Whether a project ended up watched. Some roots (`/`, the home directory, removable
 * or network-backed volumes) cannot be watched recursively at any sane cost, so we
 * decline rather than wedge the main process — and say so, instead of leaving the
 * user wondering why nothing updates live.
 */
export interface WatchResult {
  cwd: string
  watching: boolean
  /** Why watching was declined, for the UI to show. */
  reason?: string
}

export type FileChangeType = 'add' | 'change' | 'unlink' | 'addDir' | 'unlinkDir'

export interface FileChange {
  type: FileChangeType
  /** Absolute path. */
  path: string
  /** Present for add/change, so a viewer can skip re-reading unchanged content. */
  size?: number
  mtimeMs?: number
}

/**
 * A burst of filesystem activity in a watched project, coalesced. Carrying the
 * individual paths (rather than just the project root) is what lets the renderer
 * reload the open file and skip re-listing the tree when nothing structural moved.
 */
export interface ProjectChangePayload {
  cwd: string
  /** Deduped by path, latest event per path wins. Capped — see `overflow`. */
  changes: FileChange[]
  /** Too many distinct paths to enumerate (e.g. an install or a branch switch). */
  overflow: boolean
}

export interface SheetData {
  name: string
  rows: string[][]
  /** True when the sheet was clipped to a maximum row/column count. */
  clipped?: boolean
}

export interface FileContent {
  path: string
  kind: 'markdown' | 'code' | 'binary' | 'spreadsheet'
  /** inferred language id for code highlighting (code kind) */
  language?: string
  /** text content (markdown / code kinds) */
  content: string
  /** parsed sheets (spreadsheet kind) */
  sheets?: SheetData[]
  truncated: boolean
  /** Stat at read time, so a watcher event can tell whether a re-read is needed. */
  size?: number
  mtimeMs?: number
}

// ---------------------------------------------------------------------------
// Backend health
// ---------------------------------------------------------------------------

export interface BackendHealth {
  harnessId: string
  baseUrl: string
  /** Kept for back-compat; equals `status === 'online'`. */
  online: boolean
  /**
   * 'online'  — a local baseUrl was reachable.
   * 'offline' — a baseUrl is configured but unreachable.
   * 'ready'   — no local baseUrl (hosted/login harness like base pi); not an error.
   */
  status: 'online' | 'offline' | 'ready'
  models: string[]
  error?: string
  checkedAt: string
}

// ---------------------------------------------------------------------------
// Agent driver (RPC) events
// ---------------------------------------------------------------------------

/**
 * Interactive-prompt request from the harness (RPC `extension_ui_request`). An
 * extension paused the turn via `ctx.ui.*` and awaits a matching
 * `extension_ui_response` on stdin. Mirrors pi-forge's `RpcExtensionUIRequest`
 * for the methods we support (blocking prompts + non-blocking `notify`).
 */
export type ExtensionUIRequest =
  | { id: string; method: 'select'; title: string; options: string[]; timeout?: number }
  | { id: string; method: 'confirm'; title: string; message: string; timeout?: number }
  | { id: string; method: 'input'; title: string; placeholder?: string; timeout?: number }
  | { id: string; method: 'editor'; title: string; prefill?: string }
  | { id: string; method: 'notify'; message: string; notifyType?: 'info' | 'warning' | 'error' }

/** The three response shapes the harness accepts for an `extension_ui_request`. */
export type ExtensionUIResponse =
  | { value: string }
  | { confirmed: boolean }
  | { cancelled: true }

/**
 * Loosely-typed tool arguments. The harness passes tool input through verbatim,
 * so we name only the fields we act on (`path` for edit/write, `command` for
 * bash) and keep the rest opaque.
 */
export interface ToolArgsLike {
  path?: string
  command?: string
  [k: string]: unknown
}

/**
 * Throughput/usage numbers for the live stats readout.
 *
 * Two sources feed this, and both are supported at once. When the harness reports
 * `StreamTelemetry` (a pi-forge addition, emitted by OpenAI-compatible and Mistral
 * providers) the numbers are the provider's own and `approx` is false. Otherwise
 * the driver measures throughput off the wall clock and sets `approx`, so plain
 * `pi` and Anthropic/Google-backed harnesses still get a readout — just a labelled
 * estimate. Detection is per run, so nothing needs configuring either way.
 */
export interface StatsPatch {
  tokPerSec?: number
  ttftMs?: number
  /** Speculative-decode acceptance rate (MTP), when the provider reports it. */
  acceptanceRate?: number
  /** True when these throughput figures were measured by us, not reported. */
  approx?: boolean
  usage?: Usage
  cost?: number
  contextTokens?: number
  contextWindow?: number
  contextPercent?: number
  /** Set on the authoritative `get_session_stats` result fetched at end of turn. */
  final?: boolean
}

/**
 * A single normalized event from the harness RPC stream, or one the driver
 * synthesizes for the renderer. Names match pi's own event types where they map
 * 1:1 so the stream stays recognizable against `docs/rpc.md`.
 */
export type AgentStreamEvent =
  // Turn/message lifecycle
  | { type: 'agent_start' }
  | { type: 'agent_end'; willRetry?: boolean }
  /**
   * The agent is fully idle with nothing queued — pi's own `waitForIdle` waits on
   * this. Distinct from `agent_end`, which fires per turn and is followed by
   * another turn when steering/follow-ups are pending.
   */
  | { type: 'agent_settled' }
  | { type: 'turn_start' }
  | { type: 'turn_end' }
  | { type: 'message_start'; role?: string }
  | { type: 'message_end'; usage?: Usage; stopReason?: string; model?: string }
  // Tool execution. `edit`/`write` args carry the absolute file path; `edit`
  // results carry a unified diff we can show for free.
  | { type: 'tool_execution_start'; toolCallId: string; toolName: string; args?: ToolArgsLike }
  | { type: 'tool_execution_update'; toolCallId: string; toolName: string; partialResult?: string }
  | {
      type: 'tool_execution_end'
      toolCallId: string
      toolName: string
      isError?: boolean
      diff?: string
    }
  // Queueing, compaction, retry — states that otherwise look like a hang.
  | { type: 'queue_update'; steering: string[]; followUp: string[] }
  | { type: 'compaction_start'; reason: string }
  | { type: 'compaction_end'; aborted?: boolean; errorMessage?: string }
  | {
      type: 'auto_retry_start'
      attempt: number
      maxAttempts: number
      delayMs: number
      errorMessage: string
    }
  | { type: 'auto_retry_end'; success: boolean; finalError?: string }
  | { type: 'session_info_changed'; name?: string }
  // Interactive prompts (blocking) and display-only status from extensions.
  | { type: 'extension_ui_request'; ui: ExtensionUIRequest }
  | { type: 'ui_cancelled'; id: string }
  | { type: 'ui_status'; status?: string; widget?: string[]; title?: string }
  // Driver-synthesized.
  | { type: 'session_bound'; sessionPath: string }
  | { type: 'stream_error'; reason: string }
  | { type: 'prompt_rejected'; reason: string }
  | {
      type: 'error'
      errorReason: string
      stderrTail?: string
      exitCode?: number | null
      signal?: string | null
    }
  | { type: 'agent_exit'; exitCode: number | null; signal?: string | null }
  | { type: 'unresponsive' }
  | { type: 'responsive' }
  | { type: 'stats'; patch: StatsPatch }

/**
 * One entry in a batch. Consecutive deltas of the same kind are pre-joined, so
 * replaying `items` in order reproduces the harness's stdout order exactly
 * (minus per-delta granularity, which nothing depends on).
 */
export type BatchItem =
  | { kind: 'text'; text: string }
  | { kind: 'thinking'; text: string }
  | { kind: 'event'; event: AgentStreamEvent }

/**
 * A coalesced flush of stream activity for one run. The driver batches on a
 * short timer (and flushes immediately for lifecycle events) so the renderer
 * commits once per frame instead of once per token.
 */
export interface AgentBatch {
  /** Stable id of the run this batch belongs to (assigned by the driver on open). */
  runId: string
  harnessId: string
  /** Working directory the run was opened in. */
  cwd: string
  /** Session .jsonl path once known (undefined for a brand-new chat until adopted). */
  sessionPath?: string
  /**
   * Monotonic per-run flush counter (1-based). The renderer drops batches it has
   * already applied (`seq <= last`) and resyncs from a snapshot on a gap.
   */
  seq: number
  items: BatchItem[]
}

/** Lifecycle of a single driven run. */
export type RunStatus = 'starting' | 'running' | 'finalizing' | 'idle' | 'error'

/**
 * A snapshot of a run held by the main-process registry. Returned by
 * `agentListRuns` so a freshly-loaded or reconnecting renderer can rebuild its
 * live state without a relaunch.
 */
export interface RunSnapshot {
  runId: string
  harnessId: string
  cwd: string
  sessionPath: string | null
  status: RunStatus
  currentTool?: string
  /** Epoch ms when the run was opened. */
  startedAt: number
  /** Bounded rolling buffer of in-flight (not-yet-persisted) visible text. */
  streamTail: string
  /** Bounded rolling buffer of in-flight reasoning. */
  thinkingTail: string
  /** Human-readable failure reason when status === 'error'. */
  error?: string
  /** An in-flight blocking prompt awaiting a response, so a reconnecting renderer restores it. */
  pendingUi?: ExtensionUIRequest | null
  /** The harness stopped answering liveness pings while a turn was in flight. */
  unresponsive?: boolean
  /** Latest display-only status an extension pushed via `ctx.ui.setStatus`/`setTitle`/`setWidget`. */
  uiStatus?: { status?: string; title?: string; widget?: string[] }
  /** Messages the harness is holding to deliver during / after the current turn. */
  queued?: { steering: string[]; followUp: string[] }
  /** A non-streaming activity the turn is currently occupied by. */
  phase?: 'compacting' | 'retrying' | null
  /** In-flight automatic retry after a provider failure. */
  retry?: {
    attempt: number
    maxAttempts: number
    delayMs: number
    /** Epoch ms the backoff started, so a countdown survives a reconnect. */
    startedAt: number
    errorMessage: string
  }
}

// ---------------------------------------------------------------------------
// Harness installer (one-click presets)
// ---------------------------------------------------------------------------

export interface HarnessPresetStatus {
  preset: import('./harness-presets').HarnessPreset
  /** Install root / agent dir already exists on disk (or the global CLI resolves). */
  installed: boolean
  /** A harness pointing at this preset's agent dir is registered in the app. */
  registered: boolean
}

export interface InstallEvent {
  presetId: string
  type: 'stdout' | 'stderr' | 'done' | 'error'
  /** A streamed output line (for 'stdout' | 'stderr'). */
  line?: string
  /** Process exit code (for 'done' | 'error'). */
  code?: number | null
  /** Failure reason (for 'error'). */
  reason?: string
}

// ---------------------------------------------------------------------------
// IPC channel contract (exposed via window.heph)
// ---------------------------------------------------------------------------

export interface HephApi {
  /** Absolute path of a dropped File (replaces the removed `File.path`). */
  getPathForFile(file: File): string

  /** The user's home directory, so the renderer can expand `~` in file references. */
  readonly homeDir: string

  listHarnesses(): Promise<HarnessConfig[]>
  addHarness(input: { label: string; agentDir: string }): Promise<HarnessConfig[]>
  removeHarness(id: string): Promise<HarnessConfig[]>

  // One-click harness installers
  getHarnessPresets(): Promise<HarnessPresetStatus[]>
  installHarness(input: {
    presetId: string
    mode: 'install' | 'update'
  }): Promise<{ ok: boolean; harnesses?: HarnessConfig[]; harnessId?: string; reason?: string }>

  listProjects(harnessId: string): Promise<ProjectSummary[]>
  loadSession(harnessId: string, path: string): Promise<SessionDetail>
  getModels(harnessId: string): Promise<ModelsConfig | null>

  /** Top level of a project only; deeper levels come from `listDir` on expand. */
  listFiles(cwd: string): Promise<DirListing>
  /** One directory level, for lazily expanding a tree node. */
  listDir(path: string): Promise<DirListing>
  /** Bounded background walk feeding file-reference recognition in chat. */
  indexPaths(cwd: string): Promise<PathIndex>
  readFile(path: string): Promise<FileContent>
  watchProject(cwd: string): Promise<WatchResult>

  /** Open a web link in the user's browser. Main allows http(s) only. */
  openExternal(url: string): Promise<void>

  browseFolder(): Promise<string | null>
  addProject(input: { harnessId: string; cwd: string }): Promise<ProjectSummary[]>
  removeProject(input: { harnessId: string; encoded: string }): Promise<void>

  checkBackend(harnessId: string): Promise<BackendHealth>

  // Agent driver
  agentOpen(input: {
    harnessId: string
    cwd: string
    sessionPath?: string
  }): Promise<{ ok: boolean; reason?: string; runId?: string }>
  /**
   * Send a prompt. While a turn is already streaming the harness requires a
   * `behavior`: `steer` lands in the current turn, `followUp` queues for the
   * next one (the default).
   */
  agentSend(input: {
    runId: string
    text: string
    behavior?: 'steer' | 'followUp'
  }): Promise<{ ok: boolean; reason?: string }>
  /** Answer an in-flight interactive prompt (RPC `extension_ui_response`). */
  agentRespond(input: { runId: string; response: ExtensionUIResponse }): Promise<void>
  agentAbort(runId: string): Promise<void>
  /** Cancel a pending auto-retry instead of waiting out its backoff. */
  agentAbortRetry(runId: string): Promise<void>
  agentClose(runId: string): Promise<void>
  /** Snapshot every live run so the renderer can resync after a reload/disconnect. */
  agentListRuns(): Promise<RunSnapshot[]>

  // Subscriptions (return an unsubscribe fn)
  onSessionUpdated(cb: (payload: SessionUpdatePayload) => void): () => void
  onAgentBatch(cb: (batch: AgentBatch) => void): () => void
  onProjectChanged(cb: (payload: ProjectChangePayload) => void): () => void
  onInstallProgress(cb: (event: InstallEvent) => void): () => void
}

declare global {
  interface Window {
    heph: HephApi
  }
}
