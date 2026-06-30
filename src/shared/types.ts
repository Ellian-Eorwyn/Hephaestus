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

export interface FileContent {
  path: string
  /** 'markdown' | 'code' | 'binary' */
  kind: 'markdown' | 'code' | 'binary'
  /** inferred language id for code highlighting */
  language?: string
  content: string
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
  harnessId: string
  sessionPath?: string
  /** Raw event type from the harness RPC stream. */
  type: string
  /** Streaming visible-text delta, when present. */
  delta?: string
  /** Streaming reasoning/thinking delta, when present. */
  thinkingDelta?: string
  toolName?: string
  raw?: unknown
}

export type AgentStatus = 'idle' | 'starting' | 'running' | 'error' | 'closed'

// ---------------------------------------------------------------------------
// IPC channel contract (exposed via window.heph)
// ---------------------------------------------------------------------------

export interface HephApi {
  listHarnesses(): Promise<HarnessConfig[]>
  addHarness(input: { label: string; agentDir: string }): Promise<HarnessConfig[]>
  removeHarness(id: string): Promise<HarnessConfig[]>

  listProjects(harnessId: string): Promise<ProjectSummary[]>
  loadSession(harnessId: string, path: string): Promise<SessionDetail>
  getModels(harnessId: string): Promise<ModelsConfig | null>

  listFiles(cwd: string): Promise<FileNode[]>
  readFile(path: string): Promise<FileContent>

  checkBackend(harnessId: string): Promise<BackendHealth>

  // Agent driver
  agentOpen(input: { harnessId: string; cwd: string; sessionPath?: string }): Promise<{ ok: boolean; reason?: string }>
  agentSend(input: { harnessId: string; text: string }): Promise<{ ok: boolean; reason?: string }>
  agentAbort(harnessId: string): Promise<void>
  agentClose(harnessId: string): Promise<void>

  // Subscriptions (return an unsubscribe fn)
  onSessionUpdated(cb: (payload: { harnessId: string; path: string }) => void): () => void
  onAgentEvent(cb: (event: AgentEvent) => void): () => void
}

declare global {
  interface Window {
    heph: HephApi
  }
}
