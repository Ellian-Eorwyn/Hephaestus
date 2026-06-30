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

export interface FileNode {
  name: string
  path: string
  type: 'file' | 'dir'
  children?: FileNode[]
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
}

// ---------------------------------------------------------------------------
// Backend health
// ---------------------------------------------------------------------------

export interface BackendHealth {
  harnessId: string
  baseUrl: string
  online: boolean
  models: string[]
  error?: string
  checkedAt: string
}

// ---------------------------------------------------------------------------
// Agent driver (RPC) events
// ---------------------------------------------------------------------------

export interface AgentEvent {
  /** Stable id of the run this event belongs to (assigned by the driver on open). */
  runId: string
  harnessId: string
  /** Working directory the run was opened in. */
  cwd?: string
  /** Session .jsonl path once known (undefined for a brand-new chat until adopted). */
  sessionPath?: string
  /** Raw event type from the harness RPC stream. */
  type: string
  /** Streaming visible-text delta, when present. */
  delta?: string
  /** Streaming reasoning/thinking delta, when present. */
  thinkingDelta?: string
  toolName?: string
  // Abnormal-termination detail (carried on `error`/`agent_exit` events).
  exitCode?: number | null
  signal?: string | null
  errorReason?: string
  stderrTail?: string
  raw?: unknown
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
}

// ---------------------------------------------------------------------------
// IPC channel contract (exposed via window.heph)
// ---------------------------------------------------------------------------

export interface HephApi {
  /** Absolute path of a dropped File (replaces the removed `File.path`). */
  getPathForFile(file: File): string

  listHarnesses(): Promise<HarnessConfig[]>
  addHarness(input: { label: string; agentDir: string }): Promise<HarnessConfig[]>
  removeHarness(id: string): Promise<HarnessConfig[]>

  listProjects(harnessId: string): Promise<ProjectSummary[]>
  loadSession(harnessId: string, path: string): Promise<SessionDetail>
  getModels(harnessId: string): Promise<ModelsConfig | null>

  listFiles(cwd: string): Promise<FileNode[]>
  readFile(path: string): Promise<FileContent>
  watchProject(cwd: string): Promise<void>

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
  agentSend(input: { runId: string; text: string }): Promise<{ ok: boolean; reason?: string }>
  agentAbort(runId: string): Promise<void>
  agentClose(runId: string): Promise<void>
  /** Snapshot every live run so the renderer can resync after a reload/disconnect. */
  agentListRuns(): Promise<RunSnapshot[]>

  // Subscriptions (return an unsubscribe fn)
  onSessionUpdated(cb: (payload: { harnessId: string; path: string }) => void): () => void
  onAgentEvent(cb: (event: AgentEvent) => void): () => void
  onProjectChanged(cb: (cwd: string) => void): () => void
}

declare global {
  interface Window {
    heph: HephApi
  }
}
