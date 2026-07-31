import { create } from 'zustand'
import type {
  HarnessConfig,
  ProjectSummary,
  SessionSummary,
  SessionUpdatePayload,
  SessionDetail,
  FileNode,
  FileChangeType,
  FileContent,
  BackendHealth,
  AgentBatch,
  AgentStreamEvent,
  StatsPatch,
  RunStatus,
  RunSnapshot,
  ThreadMessage,
  HarnessPresetStatus,
  ExtensionUIRequest,
  ExtensionUIResponse
} from '@shared/types'
import { wrapWithContext } from '@shared/viewing-context'
import { isInside, resolveProjectPath, trimTrailingSlash } from '@shared/paths'
import { ancestorDirs, collectPaths, loadedDirs, mergeListing, setChildren } from '../lib/filetree'

const heph = window.heph

type View = 'dashboard' | { harnessId: string }

/**
 * Renderer-side mirror of a main-process run — everything *except* the stream
 * text. The accumulated text lives in `streams`, keyed by the same runId, so the
 * ~30 commits/sec of a live turn touch only that map. Anything watching runs
 * (the sidebar, the status bar, the composer) then re-renders on real lifecycle
 * changes instead of on every frame of output.
 */
export interface RunMeta {
  runId: string
  harnessId: string
  cwd: string
  sessionPath: string | null
  status: RunStatus
  currentTool?: string
  startedAt: number
  error?: string
  /** The harness stopped answering liveness pings mid-turn. */
  unresponsive?: boolean
  /** Display-only status pushed by a harness extension (`ctx.ui.setStatus`). */
  uiStatus?: { status?: string; title?: string; widget?: string[] }
  /** Messages the harness is holding to deliver during / after the current turn. */
  queued?: { steering: string[]; followUp: string[] }
  /** A non-streaming activity the turn is occupied by (otherwise it looks like a hang). */
  phase?: 'compacting' | 'retrying' | null
  /** In-flight automatic retry after a provider failure. */
  retry?: {
    attempt: number
    maxAttempts: number
    delayMs: number
    startedAt: number
    errorMessage: string
  }
}

/**
 * Accumulated stream buffers for one run. `rev` counts applied batches so an
 * effect can depend on "the stream advanced" without diffing strings.
 */
export interface RunStream {
  text: string
  thinking: string
  rev: number
}

const EMPTY_STREAM: RunStream = { text: '', thinking: '', rev: 0 }

/**
 * Did any displayed field of a run actually change? Lets a text-only batch skip
 * replacing the `runs` map, which is what keeps the sidebar and status bar still
 * during a stream.
 */
function shallowEqualMeta(a: RunMeta, b: RunMeta): boolean {
  return (
    a.status === b.status &&
    a.currentTool === b.currentTool &&
    a.sessionPath === b.sessionPath &&
    a.cwd === b.cwd &&
    a.error === b.error &&
    a.unresponsive === b.unresponsive &&
    a.uiStatus === b.uiStatus &&
    a.queued === b.queued &&
    a.phase === b.phase &&
    a.retry === b.retry
  )
}

/** A blocking interactive prompt from the harness awaiting the user's answer. */
export interface PendingPrompt {
  /** The request id (matches the harness's extension_ui_request). */
  id: string
  runId: string
  cwd: string
  sessionPath: string | null
  /** Only blocking methods become prompts; `notify` is surfaced as a Notice instead. */
  request: Exclude<ExtensionUIRequest, { method: 'notify' }>
}

/** A transient, non-blocking notice from the harness (`notify`). */
export interface Notice {
  id: string
  message: string
  kind: 'info' | 'warning' | 'error'
}

/** Pending prompts belonging to a given run. */
export function promptsForRun(
  pendingPrompts: Record<string, PendingPrompt>,
  runId: string | undefined
): PendingPrompt[] {
  if (!runId) return []
  return Object.values(pendingPrompts).filter((p) => p.runId === runId)
}

const ACTIVE: RunStatus[] = ['starting', 'running', 'finalizing']
export function isActive(status: RunStatus): boolean {
  return ACTIVE.includes(status)
}

/** Renderer-side state for a one-click harness install/update in progress. */
export interface InstallLog {
  status: 'idle' | 'running' | 'done' | 'error'
  lines: string[]
}

/**
 * Whether the agent is actively producing output — drives the hammer/anvil
 * animation and the Stop button. `finalizing` is excluded: the turn is done and
 * its text is settled, just awaiting the authoritative reload, so it renders as a
 * calm assistant bubble rather than a striking hammer.
 */
export function isWorking(status: RunStatus): boolean {
  return status === 'starting' || status === 'running'
}

/** Trailing-slash-tolerant path equality (renderer has no node:path). */
export function samePath(a?: string | null, b?: string | null): boolean {
  if (!a || !b) return false
  const norm = (p: string) => p.replace(/\/+$/, '')
  return norm(a) === norm(b)
}

/**
 * File-path equality for matching watcher events against the open file. Exact
 * first, then case-insensitive — macOS filesystems are case-insensitive by
 * default, so chokidar and our own path can differ only in case and still be the
 * same file. (On a case-sensitive volume this could in principle conflate two
 * files differing only by case; missing a live update is the worse failure.)
 */
export function sameFilePath(a?: string | null, b?: string | null): boolean {
  if (!a || !b) return false
  if (a === b) return true
  return a.toLowerCase() === b.toLowerCase()
}

type RunTargetState = {
  runs: Record<string, RunMeta>
  selectedSessionPath: string | null
  selectedCwd: string | null
}

/**
 * The run feeding the currently-viewed session: matched by sessionPath when a
 * session is selected, or — for a brand-new chat not yet written to disk — the
 * pathless run for the selected cwd.
 *
 * Returns the id rather than the object so subscribers get a string primitive and
 * don't re-render when unrelated fields of the run change.
 */
export function selectCurrentRunId(s: RunTargetState): string | null {
  const list = Object.values(s.runs)
  if (s.selectedSessionPath) {
    return list.find((r) => samePath(r.sessionPath, s.selectedSessionPath))?.runId ?? null
  }
  if (s.selectedCwd) {
    return (
      list.find((r) => !r.sessionPath && samePath(r.cwd, s.selectedCwd) && isActive(r.status))
        ?.runId ?? null
    )
  }
  return null
}

export function selectCurrentRun(s: RunTargetState): RunMeta | null {
  const id = selectCurrentRunId(s)
  return id ? (s.runs[id] ?? null) : null
}

/** Number of runs currently doing something — a primitive for the status bar. */
export function countActive(runs: Record<string, RunMeta>): number {
  let n = 0
  for (const id in runs) if (isActive(runs[id].status)) n++
  return n
}

function snapshotToMeta(s: RunSnapshot): RunMeta {
  return {
    runId: s.runId,
    harnessId: s.harnessId,
    cwd: s.cwd,
    sessionPath: s.sessionPath,
    status: s.status,
    currentTool: s.currentTool,
    startedAt: s.startedAt,
    error: s.error,
    unresponsive: s.unresponsive,
    uiStatus: s.uiStatus
  }
}

/**
 * Last applied batch seq per run. Batches are ordered and monotonic, so this
 * both drops duplicates (a double-registered listener under StrictMode would
 * otherwise append every delta twice) and detects a dropped batch.
 */
const lastSeq = new Map<string, number>()

/**
 * Main-process subscriptions are process-wide, not per-mount. `init()` runs again
 * on every StrictMode remount, so guard the wiring — registering the batch
 * listener twice would apply every batch twice.
 */
let wired = false
const unsubscribes: Array<() => void> = []
/** Guards against overlapping full tree re-listings during a burst of changes. */
let relistInFlight = false
/** The same, for the background path index — see `patchProjectIndex`. */
let reindexInFlight = false

function wireSubscriptions(
  get: () => State,
  set: (patch: Partial<State> | ((s: State) => Partial<State>)) => void
): void {
  // Live session updates -> refresh open session if it changed.
  unsubscribes.push(
    heph.onSessionUpdated((payload) => {
      void get().applySessionUpdate(payload)
    })
  )
  unsubscribes.push(heph.onAgentBatch((b) => get().applyAgentBatch(b)))
  unsubscribes.push(
    heph.onProjectChanged((payload) => {
      const st = get()
      if (!samePath(st.selectedCwd, payload.cwd)) return

      // Keep the reference index in step with what just appeared or vanished, so a
      // path the agent names is clickable in the same reply that creates it. Only
      // structural events carry index work — a plain content edit, the common case,
      // costs nothing here.
      if (payload.overflow) {
        // Too much moved to enumerate; the only honest answer is another walk. It is
        // bounded in the main process (20k entries / 1.5s), so this stays cheap.
        if (!reindexInFlight) {
          reindexInFlight = true
          void heph
            .indexPaths(payload.cwd)
            .then((index) => {
              if (!samePath(get().selectedCwd, payload.cwd)) return
              set({ projectIndex: new Set(index.paths) })
            })
            .catch(() => {})
            .finally(() => {
              reindexInFlight = false
            })
        }
      } else {
        const of = (...types: FileChangeType[]): string[] =>
          payload.changes.filter((c) => types.includes(c.type)).map((c) => c.path)
        const add = of('add', 'addDir')
        const remove = of('unlink')
        const removeTrees = of('unlinkDir')
        if (add.length || remove.length || removeTrees.length) {
          patchProjectIndex(payload.cwd, { add, remove, removeTrees }, set, get)
        }
      }

      // Only a structural change moves the tree. A plain content edit — which is
      // what the agent does most — leaves the listing identical, so re-listing for
      // it is pure waste.
      const structural =
        payload.overflow || payload.changes.some((c) => c.type !== 'change')
      // A mass event (an install, a branch switch) reaches us as a trickle of
      // bursts rather than one, so collapse overlapping re-lists into one pass.
      // Only the levels that are actually open get re-listed — the tree below a
      // collapsed folder is not loaded, so there is nothing there to refresh.
      if (structural && !relistInFlight) {
        relistInFlight = true
        void (async () => {
          try {
            const listing = await heph.listFiles(payload.cwd)
            if (!samePath(get().selectedCwd, payload.cwd)) return
            set((s) => ({ fileTree: mergeRootListing(s.fileTree, listing.nodes) }))
            const touched = new Set(payload.changes.map((c) => parentDir(c.path)))
            for (const dir of loadedDirs(get().fileTree)) {
              if (payload.overflow || touched.has(dir)) await refreshDir(dir, set, get)
            }
          } catch {
            // ignore
          } finally {
            relistInFlight = false
          }
        })()
      }

      // Reload the open file. This is the step that was missing: the watcher fired
      // and the tree refreshed, but `fileContent` was only ever written by a click,
      // so the preview kept showing the bytes captured when you opened it.
      const open = st.selectedFile
      if (!open) return
      const hit = payload.changes.find((c) => sameFilePath(c.path, open))
      if (!hit && !payload.overflow) return

      if (hit?.type === 'unlink') {
        // Keep the last content on screen (it's still the most useful thing to
        // show) and mark it gone.
        set({ fileMissing: true })
        return
      }
      const cur = st.fileContent
      if (
        hit &&
        cur &&
        cur.mtimeMs !== undefined &&
        cur.mtimeMs === hit.mtimeMs &&
        cur.size === hit.size
      ) {
        return
      }
      heph
        .readFile(open)
        .then((fileContent) => set({ fileContent, fileMissing: false }))
        .catch(() => set({ fileMissing: true }))
    })
  )

  // Stream one-click install output into per-preset logs.
  unsubscribes.push(
    heph.onInstallProgress((e) => {
      set((s) => {
        const prev = s.installLogs[e.presetId] ?? { status: 'idle', lines: [] }
        const next: InstallLog = { ...prev }
        if (e.type === 'stdout' || e.type === 'stderr') {
          next.status = 'running'
          next.lines = [...prev.lines, e.line ?? '']
        } else if (e.type === 'done') {
          next.status = 'done'
        } else if (e.type === 'error') {
          next.status = 'error'
          if (e.reason) next.lines = [...prev.lines, e.reason]
        }
        return { installLogs: { ...s.installLogs, [e.presetId]: next } }
      })
    })
  )

  // Resync when the window regains focus so a stale/disconnected UI self-heals
  // without a relaunch. `focus` and `visibilitychange` both fire on activation, so
  // debounce them into a single round-trip.
  let resyncTimer: ReturnType<typeof setTimeout> | null = null
  const resyncSoon = (): void => {
    if (resyncTimer) return
    resyncTimer = setTimeout(() => {
      resyncTimer = null
      void get().resyncRuns()
    }, 150)
  }
  const onVisible = (): void => {
    if (document.visibilityState === 'visible') resyncSoon()
  }
  window.addEventListener('focus', resyncSoon)
  document.addEventListener('visibilitychange', onVisible)
  unsubscribes.push(() => {
    window.removeEventListener('focus', resyncSoon)
    document.removeEventListener('visibilitychange', onVisible)
  })
}

/**
 * Bumped on every project/session selection. An in-flight load compares against it
 * before committing, so a slow response for a chat the user has already clicked away
 * from is discarded instead of overwriting the one they're looking at.
 */
let selectionSeq = 0

/**
 * Point the inspector at a project: watch it, list its top level, and reset the
 * open file. Only the *top* level is listed — see `FileService.listFiles`; deeper
 * levels load when a row is expanded.
 *
 * Never awaited by the caller on the chat path, so a slow filesystem can't hold up
 * the conversation.
 */
async function openProjectFiles(
  cwd: string,
  set: (patch: Partial<State> | ((s: State) => Partial<State>)) => void,
  get: () => State
): Promise<void> {
  const seq = selectionSeq
  set({
    fileTreeLoading: true,
    fileTree: [],
    expandedDirs: {},
    loadingDirs: {},
    projectIndex: new Set<string>(),
    watchNotice: null,
    selectedFile: null,
    selectedFileLine: null,
    fileContent: null,
    fileMissing: false
  })

  // Recognising file references in chat needs to see deeper than the visible tree,
  // so a bounded walk runs alongside — never awaited, so a slow one can't hold up
  // either the listing or the conversation.
  void heph
    .indexPaths(cwd)
    .then((index) => {
      if (seq !== selectionSeq || !samePath(get().selectedCwd, cwd)) return
      set({ projectIndex: new Set(index.paths) })
    })
    .catch(() => {})

  try {
    const [watch, listing] = await Promise.all([
      heph.watchProject(cwd).catch(() => null),
      heph.listFiles(cwd)
    ])
    // A newer selection landed while we were listing — its own call owns the state.
    if (seq !== selectionSeq || !samePath(get().selectedCwd, cwd)) return
    set({
      fileTree: listing.nodes,
      watchNotice: watch && !watch.watching ? (watch.reason ?? null) : null
    })
  } catch {
    if (seq !== selectionSeq) return
    set({ fileTree: [] })
  } finally {
    if (seq === selectionSeq) set({ fileTreeLoading: false })
  }
}

/** Fetch a directory's children once; a second call for a loaded dir is a no-op. */
async function loadDirOnce(
  dirPath: string,
  set: (patch: Partial<State> | ((s: State) => Partial<State>)) => void,
  get: () => State
): Promise<void> {
  const node = findDir(get().fileTree, dirPath)
  if (node?.loaded || get().loadingDirs[dirPath]) return
  await refreshDir(dirPath, set, get)
}

/** (Re-)list one directory level and splice it into the tree. */
async function refreshDir(
  dirPath: string,
  set: (patch: Partial<State> | ((s: State) => Partial<State>)) => void,
  get: () => State
): Promise<void> {
  const cwd = get().selectedCwd
  set((s) => ({ loadingDirs: { ...s.loadingDirs, [dirPath]: true } }))
  try {
    const listing = await heph.listDir(dirPath)
    // The project may have changed under us while the listing was in flight.
    if (!samePath(get().selectedCwd, cwd)) return
    set((s) => ({
      fileTree: setChildren(s.fileTree, dirPath, listing.nodes, listing.truncated)
    }))
  } catch {
    // A directory that vanished or can't be read: leave it collapsed.
  } finally {
    set((s) => {
      const loadingDirs = { ...s.loadingDirs }
      delete loadingDirs[dirPath]
      return { loadingDirs }
    })
  }
}

/** The `dir` node at `target`, searching only loaded levels. */
function findDir(nodes: FileNode[], target: string): FileNode | null {
  for (const n of nodes) {
    if (n.path === target) return n.type === 'dir' ? n : null
    if (n.children) {
      const hit = findDir(n.children, target)
      if (hit) return hit
    }
  }
  return null
}

/** Merge a fresh root listing over the current one, keeping expanded subtrees. */
function mergeRootListing(prev: FileNode[], fresh: FileNode[]): FileNode[] {
  return mergeListing(prev, fresh)
}

/**
 * Every path we know about in the current project — the background index plus
 * whatever the visible tree has loaded — as the validator for path-shaped strings
 * in an agent's reply.
 *
 * Cached on the identities of both inputs, so the union is built once per change
 * rather than once per rendered message: this is read by every markdown block.
 */
const treePathCache = new WeakMap<FileNode[], Set<string>>()
let knownCache: {
  tree: FileNode[]
  index: Set<string>
  value: { known: Set<string>; byBasename: Map<string, string> }
} | null = null

export function selectKnownPaths(s: State): {
  known: Set<string>
  byBasename: Map<string, string>
} {
  if (knownCache && knownCache.tree === s.fileTree && knownCache.index === s.projectIndex) {
    return knownCache.value
  }
  let fromTree = treePathCache.get(s.fileTree)
  if (!fromTree) {
    fromTree = collectPaths(s.fileTree)
    treePathCache.set(s.fileTree, fromTree)
  }
  // The index usually covers the tree, so start from it and add anything the tree
  // has that the (bounded) walk missed.
  const known = new Set(s.projectIndex)
  for (const p of fromTree) known.add(p)

  // Basenames that occur exactly once. A name seen twice is dropped outright
  // rather than resolved to an arbitrary one of its candidates.
  const byBasename = new Map<string, string>()
  const ambiguous = new Set<string>()
  for (const p of known) {
    const name = p.slice(p.lastIndexOf('/') + 1)
    if (ambiguous.has(name)) continue
    if (byBasename.has(name)) {
      byBasename.delete(name)
      ambiguous.add(name)
    } else {
      byBasename.set(name, p)
    }
  }

  const value = { known, byBasename }
  knownCache = { tree: s.fileTree, index: s.projectIndex, value }
  return value
}

/**
 * Pending additions/removals for `projectIndex`, flushed on a trailing timer.
 *
 * Every commit gives the index a new identity, which is what makes
 * `selectKnownPaths` recompute — and because `MarkdownBody` subscribes to that
 * selector directly, the memo on `Message` doesn't stop the whole visible transcript
 * re-parsing. A branch switch or a multi-file edit arrives as a run of short bursts,
 * so coalescing them is the difference between one re-parse and fifty.
 */
let indexPatch: { add: Set<string>; remove: Set<string>; removeTrees: Set<string> } | null = null
let indexTimer: ReturnType<typeof setTimeout> | null = null
const INDEX_PATCH_DEBOUNCE_MS = 250

/**
 * Fold created/deleted paths into `projectIndex` without re-walking the project.
 *
 * The index is otherwise built once, when the project opens — so a file the agent
 * creates mid-conversation, which is exactly the one worth clicking, was never
 * recognised in its own reply. `removeTrees` sweeps a deleted directory's subtree:
 * chokidar names only the directory, and its own per-file `unlink` events stop at
 * the watch depth.
 */
function patchProjectIndex(
  cwd: string,
  patch: { add?: string[]; remove?: string[]; removeTrees?: string[] },
  set: (patch: Partial<State> | ((s: State) => Partial<State>)) => void,
  get: () => State
): void {
  const acc = (indexPatch ??= { add: new Set(), remove: new Set(), removeTrees: new Set() })
  for (const p of patch.add ?? []) {
    acc.add.add(p)
    acc.remove.delete(p)
  }
  for (const p of patch.remove ?? []) {
    acc.remove.add(p)
    acc.add.delete(p)
  }
  for (const p of patch.removeTrees ?? []) acc.removeTrees.add(p)

  if (indexTimer) return
  indexTimer = setTimeout(() => {
    indexTimer = null
    const pending = indexPatch
    indexPatch = null
    // The project may have changed while the timer was pending; its own open call
    // owns the index now.
    if (!pending || !samePath(get().selectedCwd, cwd)) return
    set((s) => {
      // Replaced, never mutated: `projectIndex` is a cache key in `selectKnownPaths`,
      // so an in-place `add` would leave every rendered message resolving against the
      // union built before the file existed.
      const projectIndex = new Set(s.projectIndex)
      for (const p of pending.add) projectIndex.add(p)
      for (const p of pending.remove) projectIndex.delete(p)
      for (const dir of pending.removeTrees) {
        const prefix = `${trimTrailingSlash(dir)}/`
        for (const p of projectIndex) if (p === dir || p.startsWith(prefix)) projectIndex.delete(p)
      }
      return { projectIndex }
    })
  }, INDEX_PATCH_DEBOUNCE_MS)
}

/** Containing directory of an absolute path (renderer has no `node:path`). */
function parentDir(p: string): string {
  const idx = p.replace(/\/+$/, '').lastIndexOf('/')
  return idx <= 0 ? '/' : p.slice(0, idx)
}

/** How long an agent edit stays interesting enough to keep in the map. */
const AGENT_EDIT_TTL_MS = 5 * 60_000

/**
 * Merge a stats patch over the running values. Only fields actually present in the
 * patch overwrite, so a usage-only update from `message_end` doesn't wipe the
 * throughput figures the provider reported mid-stream.
 */
function mergeStats(prev: StatsPatch, patch: StatsPatch): StatsPatch {
  const next: StatsPatch = { ...prev }
  for (const k of Object.keys(patch) as (keyof StatsPatch)[]) {
    const v = patch[k]
    if (v !== undefined) (next[k] as unknown) = v
  }
  return next
}

/** Tools that write to disk, and whose `path` argument is therefore worth flagging. */
const WRITING_TOOLS = new Set(['edit', 'write'])

/**
 * Absolute paths the agent is writing in this batch. `bash` is deliberately
 * excluded: its command is opaque, so any file it touches surfaces through the
 * filesystem watcher instead.
 */
function collectEditedPaths(events: AgentStreamEvent[], cwd: string): string[] {
  const out: string[] = []
  for (const e of events) {
    if (e.type !== 'tool_execution_start' && e.type !== 'tool_execution_end') continue
    if (!WRITING_TOOLS.has(e.toolName)) continue
    const raw = e.type === 'tool_execution_start' ? e.args?.path : undefined
    if (typeof raw !== 'string' || !raw) continue
    // Tool paths are normally absolute; resolve the occasional relative one
    // against the run's working directory.
    const abs = resolveProjectPath(cwd, raw, heph.homeDir)
    if (abs) out.push(abs)
  }
  return out
}

/** Fold one stream event into a run draft. Mutates — the caller owns the copy. */
function applyEventToRun(r: RunMeta, e: AgentStreamEvent): void {
  switch (e.type) {
    case 'tool_execution_start':
      r.currentTool = e.toolName
      break
    case 'tool_execution_end':
      if (r.currentTool === e.toolName) r.currentTool = undefined
      break
    case 'agent_end': {
      r.currentTool = undefined
      r.phase = null
      // Each queued message runs as its own turn, so `agent_end` only ends *this*
      // turn. With work still queued the run keeps going; only the last turn hands
      // off to the authoritative reload.
      const pending = (r.queued?.steering.length ?? 0) + (r.queued?.followUp.length ?? 0)
      if (pending === 0) r.status = 'finalizing'
      break
    }
    case 'agent_settled':
      // Nothing left queued. This is the reliable end-of-work signal (pi's own
      // waitForIdle uses it), and it covers the case where a queued turn ended
      // without us seeing the queue drain.
      if (r.status === 'running') r.status = 'finalizing'
      r.phase = null
      r.retry = undefined
      break
    case 'queue_update':
      r.queued = { steering: e.steering, followUp: e.followUp }
      break
    case 'compaction_start':
      r.phase = 'compacting'
      break
    case 'compaction_end':
      r.phase = null
      break
    case 'auto_retry_start':
      r.phase = 'retrying'
      r.retry = {
        attempt: e.attempt,
        maxAttempts: e.maxAttempts,
        delayMs: e.delayMs,
        startedAt: Date.now(),
        errorMessage: e.errorMessage
      }
      break
    case 'auto_retry_end':
      r.phase = null
      r.retry = undefined
      break
    case 'agent_exit':
      if (r.status !== 'error' && r.status !== 'finalizing') r.status = 'idle'
      break
    case 'error':
      r.status = 'error'
      r.error = e.errorReason
      break
    case 'unresponsive':
      r.unresponsive = true
      break
    case 'responsive':
      r.unresponsive = undefined
      break
    case 'ui_status': {
      const next = { ...(r.uiStatus ?? {}) }
      if ('status' in e) next.status = e.status
      if ('title' in e) next.title = e.title
      if ('widget' in e) next.widget = e.widget
      r.uiStatus = next
      break
    }
    default:
      break
  }
}

/** Stable key identifying a project within a harness (used for archiving). */
export function projectKey(harnessId: string, encoded: string): string {
  return `${harnessId}::${encoded}`
}

function loadArchived(): string[] {
  try {
    const raw = localStorage.getItem('heph.archived')
    return raw ? (JSON.parse(raw) as string[]) : []
  } catch {
    return []
  }
}

function loadSettings() {
  try {
    const raw = localStorage.getItem('heph.settings')
    if (raw) return JSON.parse(raw)
  } catch {
    // ignore
  }
  return {
    messageSpacing: 'compact',
    showThinking: true,
    showTools: true,
    showToolResults: true,
    autoAttachFile: true,
    fileLinkGuidance: true,
    reduceMotion: false
  }
}

interface State {
  // top-level
  harnesses: HarnessConfig[]
  view: View
  theme: 'dark' | 'light'
  zen: boolean
  addModalOpen: boolean
  inspectorDock: 'right' | 'bottom'

  // per active harness
  projects: ProjectSummary[]
  expanded: Record<string, boolean> // encoded -> expanded
  selectedCwd: string | null

  // archiving
  archived: string[] // project keys (harnessId::encoded)
  selectionMode: boolean
  selectedForArchive: string[] // project keys checked in selection mode

  // center
  selectedSessionPath: string | null
  session: SessionDetail | null
  loadingSession: boolean

  // live runs (keyed by runId) — renderer mirror of the main-process registry
  runs: Record<string, RunMeta>
  /**
   * In-flight stream text, keyed by runId. Split out of `runs` because this is the
   * only slice that changes per frame during a turn.
   */
  streams: Record<string, RunStream>
  /**
   * Live throughput/usage per run, merged as stats patches arrive. Cleared when a
   * run retires.
   */
  statsLive: Record<string, StatsPatch>
  /**
   * Authoritative end-of-turn totals per session path. Outlives the run, so the
   * status bar keeps showing real cost/context after the turn finishes.
   */
  sessionStats: Record<string, StatsPatch>
  /** True while a resync (agentListRuns) is in flight, for the reconnect chip. */
  reconnecting: boolean

  // interactive prompts (extension_ui_request), keyed by request id
  pendingPrompts: Record<string, PendingPrompt>
  /** Transient non-blocking notices from the harness (`notify`). */
  notices: Notice[]
  /**
   * Text handed back to the composer after the harness refused a prompt, so the
   * message isn't lost. The composer consumes and clears it.
   */
  draftRestore: string | null

  // inspector
  fileTree: FileNode[]
  /** True while the top level of a newly-selected project is being listed. */
  fileTreeLoading: boolean
  /**
   * Which directories are open, keyed by absolute path. Lifted out of the tree rows
   * so a file the agent links to can be revealed from outside the component — and
   * so the expansion survives a refresh of the listing.
   */
  expandedDirs: Record<string, boolean>
  /** Directories with a `listDir` in flight, so a row can show it's working. */
  loadingDirs: Record<string, boolean>
  /**
   * Bounded flat index of paths under the project, built in the background after a
   * project opens. Only feeds file-reference recognition in chat — the visible tree
   * stays lazy, so on its own it would only know the levels someone expanded.
   */
  projectIndex: Set<string>
  /** Set when a project root is too large to watch; shown as a note in the pane. */
  watchNotice: string | null
  selectedFile: string | null
  /** Line to scroll to in the preview, from a `path:42` style reference. */
  selectedFileLine: number | null
  /** A file just revealed by a link; the matching tree row scrolls itself into view. */
  revealTarget: string | null
  fileContent: FileContent | null
  /** The open file was deleted on disk; its last content is still shown. */
  fileMissing: boolean
  /**
   * Absolute path -> epoch ms of the last time the agent wrote to it, taken from
   * the RPC tool stream. Drives the "just edited" flash in the tree, and arrives
   * before the filesystem event does.
   */
  agentEdits: Record<string, number>
  /** When true, the file being viewed is silently attached to the next prompt. */
  attachViewedFile: boolean

  // status
  backend: Record<string, BackendHealth>

  // one-click installers
  harnessPresets: HarnessPresetStatus[]
  installLogs: Record<string, InstallLog>

  // actions
  init: () => Promise<void>
  setView: (v: View) => void
  toggleTheme: () => void
  toggleZen: () => void
  toggleInspectorDock: () => void
  setAddModal: (open: boolean) => void

  // settings
  settingsModalOpen: boolean
  messageSpacing: 'compact' | 'cozy' | 'comfortable'
  showThinking: boolean
  showTools: boolean
  showToolResults: boolean
  autoAttachFile: boolean
  /** Ask the agent, on every prompt, to write file paths in a form the UI can link. */
  fileLinkGuidance: boolean
  reduceMotion: boolean
  setSettingsModalOpen: (open: boolean) => void
  setTheme: (theme: 'dark' | 'light') => void
  updateSettings: (
    updates: Partial<{
      messageSpacing: 'compact' | 'cozy' | 'comfortable'
      showThinking: boolean
      showTools: boolean
      showToolResults: boolean
      autoAttachFile: boolean
      fileLinkGuidance: boolean
      reduceMotion: boolean
    }>
  ) => void

  addHarness: (input: { label: string; agentDir: string }) => Promise<void>
  removeHarness: (id: string) => Promise<void>
  loadHarnessPresets: () => Promise<void>
  installHarness: (presetId: string, mode: 'install' | 'update') => Promise<void>

  activeHarnessId: () => string | null
  loadProjects: (harnessId: string) => Promise<void>
  toggleProject: (p: ProjectSummary) => void
  selectProject: (cwd: string) => Promise<void>
  startNewChat: (cwd: string) => Promise<void>

  // archiving
  toggleSelectionMode: () => void
  toggleForArchive: (key: string) => void
  archiveSelected: () => void
  unarchive: (key: string) => void
  deleteProject: (encoded: string) => Promise<void>
  selectSession: (harnessId: string, path: string, cwd: string) => Promise<void>
  selectFile: (path: string, line?: number) => Promise<void>
  refreshFiles: () => Promise<void>
  /** Expand/collapse a directory row, fetching its children the first time. */
  toggleDir: (path: string) => Promise<void>
  /**
   * Open a file the agent referenced: expand and load its ancestors, select it in
   * the tree, and show it in the preview (optionally scrolled to `line`).
   */
  revealFile: (path: string, line?: number) => Promise<void>
  /** Consume the reveal marker once the tree row has scrolled itself into view. */
  clearRevealTarget: () => void
  setAttachViewedFile: (on: boolean) => void
  refreshBackend: (harnessId: string) => Promise<void>
  addProject: (cwd: string) => Promise<void>
  browseAndAddProject: () => Promise<void>

  /**
   * Send a prompt. While a turn is streaming this queues instead: `followUp` runs
   * after the current turn, `steer` lands inside it. Resolves false when the
   * message did not reach the agent.
   */
  sendPrompt: (text: string, behavior?: 'steer' | 'followUp') => Promise<boolean>
  /** Consume the restored draft (after a rejected prompt). */
  takeDraftRestore: () => string | null
  abortRetry: () => Promise<void>
  /** Kill an unresponsive run so the next prompt starts a fresh process. */
  restartRun: (runId: string) => Promise<void>
  answerPrompt: (id: string, response: ExtensionUIResponse) => Promise<void>
  dismissNotice: (id: string) => void
  abort: () => Promise<void>
  /**
   * Apply a session-file change. Takes the watcher's payload (which carries a
   * ready-made summary), or a bare path when we learn about a session another way
   * (a newly-bound run) and have no summary yet.
   */
  applySessionUpdate: (payload: SessionUpdatePayload | string) => Promise<void>
  /** Replace one session's row in the sidebar without re-listing the harness. */
  patchSessionSummary: (projectEncoded: string, summary: SessionSummary) => void
  applyAgentBatch: (b: AgentBatch) => void
  finalizeRun: (runId: string, attempt?: number) => Promise<void>
  resyncRuns: () => Promise<void>
}

export const useStore = create<State>((set, get) => {
  const settings = loadSettings()
  
  return {
    harnesses: [],
    view: 'dashboard',
    theme: (localStorage.getItem('heph.theme') as 'dark' | 'light') ?? 'dark',
    zen: false,
    addModalOpen: false,
    inspectorDock: (localStorage.getItem('heph.inspectorDock') as 'right' | 'bottom') ?? 'right',

    settingsModalOpen: false,
    messageSpacing: settings.messageSpacing || 'compact',
    showThinking: settings.showThinking ?? true,
    showTools: settings.showTools ?? true,
    showToolResults: settings.showToolResults ?? true,
    autoAttachFile: settings.autoAttachFile ?? true,
    fileLinkGuidance: settings.fileLinkGuidance ?? true,
    reduceMotion: settings.reduceMotion ?? false,

    projects: [],
  expanded: {},
  selectedCwd: null,

  archived: loadArchived(),
  selectionMode: false,
  selectedForArchive: [],

  selectedSessionPath: null,
  session: null,
  loadingSession: false,

  runs: {},
  streams: {},
  statsLive: {},
  sessionStats: {},
  reconnecting: false,

  pendingPrompts: {},
  notices: [],
  draftRestore: null,

  fileTree: [],
  fileTreeLoading: false,
  expandedDirs: {},
  loadingDirs: {},
  projectIndex: new Set<string>(),
  watchNotice: null,
  selectedFile: null,
  selectedFileLine: null,
  revealTarget: null,
  fileContent: null,
  fileMissing: false,
  agentEdits: {},
  attachViewedFile: settings.autoAttachFile ?? true,

  backend: {},
  harnessPresets: [],
  installLogs: {},

  init: async () => {
    document.documentElement.setAttribute('data-theme', get().theme)
    document.documentElement.setAttribute('data-reduce-motion', String(get().reduceMotion))
    const harnesses = await heph.listHarnesses()
    set({ harnesses })

    // Subscribe exactly once. React StrictMode mounts effects twice in dev, and
    // registering the batch listener twice would apply every batch twice.
    if (!wired) {
      wired = true
      wireSubscriptions(get, set)
    }

    // Load installer presets (best-effort; powers the Add Harness modal).
    void get().loadHarnessPresets()

    // Reconnect to any in-flight runs now (survives renderer reloads).
    void get().resyncRuns()

    // Kick a backend check per harness (best-effort).
    for (const h of harnesses) void get().refreshBackend(h.id)

    // Default to the first harness workspace if available.
    if (harnesses[0]) {
      set({ view: { harnessId: harnesses[0].id } })
      await get().loadProjects(harnesses[0].id)
    }
  },

  setView: (v) => {
    const prevId = get().activeHarnessId()
    const nextId = v === 'dashboard' ? null : v.harnessId
    set({ view: v, selectionMode: false, selectedForArchive: [] })
    // Switching to a different harness must clear the center/inspector selection,
    // otherwise the previous harness's session/files stay on screen.
    if (prevId !== nextId) {
      // Clear only the selection — never the run registry. A run for the
      // previous harness keeps streaming in the background and stays visible
      // via its sidebar badge / on return.
      set({
        selectedSessionPath: null,
        session: null,
        selectedCwd: null,
        fileTree: [],
        selectedFile: null,
        fileContent: null
      })
    }
    if (nextId) void get().loadProjects(nextId)
  },

  toggleTheme: () => get().setTheme(get().theme === 'dark' ? 'light' : 'dark'),

  setTheme: (theme) => {
    localStorage.setItem('heph.theme', theme)
    document.documentElement.setAttribute('data-theme', theme)
    set({ theme })
  },

  toggleZen: () => set({ zen: !get().zen }),
  toggleInspectorDock: () => {
    const next = get().inspectorDock === 'right' ? 'bottom' : 'right'
    localStorage.setItem('heph.inspectorDock', next)
    set({ inspectorDock: next })
  },
  setAddModal: (open) => set({ addModalOpen: open }),

  setSettingsModalOpen: (open) => set({ settingsModalOpen: open }),
  updateSettings: (updates) => {
    set((s) => {
      const next = {
        messageSpacing: updates.messageSpacing ?? s.messageSpacing,
        showThinking: updates.showThinking ?? s.showThinking,
        showTools: updates.showTools ?? s.showTools,
        showToolResults: updates.showToolResults ?? s.showToolResults,
        autoAttachFile: updates.autoAttachFile ?? s.autoAttachFile,
        fileLinkGuidance: updates.fileLinkGuidance ?? s.fileLinkGuidance,
        reduceMotion: updates.reduceMotion ?? s.reduceMotion
      }
      localStorage.setItem('heph.settings', JSON.stringify(next))
      if (updates.reduceMotion !== undefined) {
        document.documentElement.setAttribute('data-reduce-motion', String(next.reduceMotion))
      }
      return next
    })
  },

  addHarness: async (input) => {
    const harnesses = await heph.addHarness(input)
    set({ harnesses, addModalOpen: false })
    const added = harnesses[harnesses.length - 1]
    if (added) {
      get().setView({ harnessId: added.id })
      void get().refreshBackend(added.id)
    }
  },

  loadHarnessPresets: async () => {
    try {
      const harnessPresets = await heph.getHarnessPresets()
      set({ harnessPresets })
    } catch {
      // ignore — installer UI just won't show presets
    }
  },

  installHarness: async (presetId, mode) => {
    // Reset the log and mark running; progress streams in via onInstallProgress.
    set((s) => ({ installLogs: { ...s.installLogs, [presetId]: { status: 'running', lines: [] } } }))
    let res: Awaited<ReturnType<typeof heph.installHarness>>
    try {
      res = await heph.installHarness({ presetId, mode })
    } catch (err) {
      set((s) => ({
        installLogs: {
          ...s.installLogs,
          [presetId]: {
            status: 'error',
            lines: [...(s.installLogs[presetId]?.lines ?? []), err instanceof Error ? err.message : 'install failed']
          }
        }
      }))
      return
    }
    if (res.ok && res.harnesses) {
      set({ harnesses: res.harnesses })
      if (res.harnessId) void get().refreshBackend(res.harnessId)
    }
    // Refresh installed/registered status for all cards.
    await get().loadHarnessPresets()
    // The streamed 'done'/'error' event already set the final log status.
  },

  removeHarness: async (id) => {
    const harnesses = await heph.removeHarness(id)
    // If the removed harness was active, navigate to dashboard or first remaining harness.
    const active = get().activeHarnessId()
    if (active === id) {
      if (harnesses[0]) {
        get().setView({ harnessId: harnesses[0].id })
      } else {
        get().setView('dashboard')
      }
    }
    set({ harnesses })
  },

  activeHarnessId: () => {
    const v = get().view
    return v === 'dashboard' ? null : v.harnessId
  },

  loadProjects: async (harnessId) => {
    const projects = await heph.listProjects(harnessId)
    set({ projects })
  },

  toggleProject: (p) =>
    set((s) => ({ expanded: { ...s.expanded, [p.encoded]: !s.expanded[p.encoded] } })),

  selectProject: async (cwd) => {
    selectionSeq++
    set({ selectedCwd: cwd, selectedSessionPath: null, session: null, loadingSession: false })
    await openProjectFiles(cwd, set, get)
  },

  startNewChat: async (cwd) => {
    selectionSeq++
    set({ selectedCwd: cwd, selectedSessionPath: null, session: null, loadingSession: false })
    await openProjectFiles(cwd, set, get)
  },

  toggleSelectionMode: () =>
    set((s) => ({ selectionMode: !s.selectionMode, selectedForArchive: [] })),

  toggleForArchive: (key) =>
    set((s) => ({
      selectedForArchive: s.selectedForArchive.includes(key)
        ? s.selectedForArchive.filter((k) => k !== key)
        : [...s.selectedForArchive, key]
    })),

  archiveSelected: () => {
    const { archived, selectedForArchive } = get()
    const next = Array.from(new Set([...archived, ...selectedForArchive]))
    localStorage.setItem('heph.archived', JSON.stringify(next))
    set({ archived: next, selectionMode: false, selectedForArchive: [] })
  },

  unarchive: (key) => {
    const next = get().archived.filter((k) => k !== key)
    localStorage.setItem('heph.archived', JSON.stringify(next))
    set({ archived: next })
  },

  deleteProject: async (encoded) => {
    const harnessId = get().activeHarnessId()
    if (!harnessId) return
    await heph.removeProject({ harnessId, encoded })
    // Clean up archived list for this project
    const key = projectKey(harnessId, encoded)
    const nextArchived = get().archived.filter((k) => k !== key)
    localStorage.setItem('heph.archived', JSON.stringify(nextArchived))
    // Refresh the project list
    const projects = await heph.listProjects(harnessId)
    set({ projects, archived: nextArchived })
  },

  selectSession: async (harnessId, path, cwd) => {
    // Clearing `session` matters: it used to be left in place, so a slow or failed
    // load left the *previous* conversation on screen underneath the newly
    // highlighted row — which reads as the app having lost the chat.
    const seq = ++selectionSeq
    set({
      selectedSessionPath: path,
      selectedCwd: cwd,
      session: null,
      loadingSession: true
    })

    // The file listing is deliberately not awaited here: the conversation should
    // appear as soon as it is parsed, whatever the project folder turns out to be.
    void openProjectFiles(cwd, set, get)

    try {
      const session = await heph.loadSession(harnessId, path)
      if (seq !== selectionSeq) return // superseded by a later click
      set({ session })
    } catch (err) {
      if (seq !== selectionSeq) return
      // Never leave the pane spinning on a session that can't be read (deleted,
      // truncated, or on a volume that went away).
      const reason = err instanceof Error ? err.message : 'Could not read this session file.'
      set({
        session: {
          path,
          header: { type: 'session', cwd },
          messages: [{ id: `sys-${Date.now()}`, role: 'system', text: `⚠ ${reason}` }],
          usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: 0 },
          contextWindow: null,
          currentContextTokens: 0
        }
      })
    } finally {
      if (seq === selectionSeq) set({ loadingSession: false })
    }
  },

  selectFile: async (path, line) => {
    // Opening a new file applies the auto-attach default (Settings).
    set({
      selectedFile: path,
      selectedFileLine: line ?? null,
      attachViewedFile: get().autoAttachFile,
      fileMissing: false
    })
    try {
      const fileContent = await heph.readFile(path)
      if (get().selectedFile !== path) return
      set({ fileContent })
    } catch {
      if (get().selectedFile !== path) return
      set({ fileContent: null, fileMissing: true })
    }
  },

  toggleDir: async (dirPath) => {
    const open = !!get().expandedDirs[dirPath]
    set((s) => ({ expandedDirs: { ...s.expandedDirs, [dirPath]: !open } }))
    if (open) return
    await loadDirOnce(dirPath, set, get)
  },

  revealFile: async (path, line) => {
    const cwd = get().selectedCwd
    // Walk down from the project root, loading each level, so a file nested a few
    // folders deep can be revealed even though nothing below the root is listed yet.
    if (cwd && isInside(cwd, path)) {
      for (const dir of ancestorDirs(cwd, path)) {
        set((s) => ({ expandedDirs: { ...s.expandedDirs, [dir]: true } }))
        await loadDirOnce(dir, set, get)
      }
    }
    set({ revealTarget: path })
    await get().selectFile(path, line)
  },

  clearRevealTarget: () => set({ revealTarget: null }),

  refreshFiles: async () => {
    const cwd = get().selectedCwd
    if (!cwd) return
    try {
      void heph.watchProject(cwd)
      // Rebuild the reference index too — the user's escape hatch for anything the
      // watcher's depth limit and the tool stream both missed. Unawaited, so the
      // visible re-listing isn't held up by it.
      void heph
        .indexPaths(cwd)
        .then((index) => {
          if (!samePath(get().selectedCwd, cwd)) return
          set({ projectIndex: new Set(index.paths) })
        })
        .catch(() => {})
      // Re-list the root plus every directory the user has open, so a refresh sees
      // new files at any expanded level without walking the parts nobody opened.
      const listing = await heph.listFiles(cwd)
      if (!samePath(get().selectedCwd, cwd)) return
      set((s) => ({ fileTree: mergeRootListing(s.fileTree, listing.nodes) }))
      for (const dir of loadedDirs(get().fileTree)) {
        await refreshDir(dir, set, get)
      }
      // Refresh means refresh: re-read the open file too, not just the listing.
      const open = get().selectedFile
      if (open) {
        try {
          set({ fileContent: await heph.readFile(open), fileMissing: false })
        } catch {
          set({ fileMissing: true })
        }
      }
    } catch {
      // ignore
    }
  },

  setAttachViewedFile: (on) => set({ attachViewedFile: on }),

  refreshBackend: async (harnessId) => {
    try {
      const health = await heph.checkBackend(harnessId)
      set((s) => ({ backend: { ...s.backend, [harnessId]: health } }))
    } catch {
      // ignore
    }
  },

  addProject: async (cwd) => {
    const harnessId = get().activeHarnessId()
    if (!harnessId) return
    const projects = await heph.addProject({ harnessId, cwd })
    set({ projects })
  },

  browseAndAddProject: async () => {
    const folder = await heph.browseFolder()
    if (!folder) return
    await get().addProject(folder)
  },

  sendPrompt: async (text, behavior) => {
    const harnessId = get().activeHarnessId()
    const cwd = get().selectedCwd
    if (!harnessId || !cwd) return false

    // Silently tell the agent what it can't see: which file the user is looking at
    // (so "this" resolves), and how to write paths so its answer comes back with
    // clickable file links. The chat bubble keeps showing only the typed text (plus
    // an attachment chip).
    const file = get().selectedFile
    const attach = get().attachViewedFile && !!file
    const sentText = wrapWithContext(text, {
      file: attach ? file : null,
      fileLinks: get().fileLinkGuidance
    })

    const userMsg: ThreadMessage = {
      id: `local-${Date.now()}`,
      role: 'user',
      text,
      attachedFile: attach ? (file as string) : undefined
    }
    set((s) => {
      const fakeSession: SessionDetail = {
        path: '',
        header: { type: 'session', id: 'new', timestamp: new Date().toISOString(), cwd },
        messages: [userMsg],
        usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: 0 },
        contextWindow: null,
        currentContextTokens: 0
      }
      return {
        session: s.session
          ? { ...s.session, messages: [...s.session.messages, userMsg] }
          : fakeSession
      }
    })

    const sessionPath = get().selectedSessionPath ?? undefined

    // A turn already in flight means this is a steer / follow-up: reuse that run
    // and leave its live state completely alone. Resetting it here is what used to
    // wipe the reply on screen while the message itself was silently rejected.
    const activeId = selectCurrentRunId(get())
    const active = activeId ? get().runs[activeId] : undefined
    const midStream = !!active && isWorking(active.status)

    const open = await heph.agentOpen({ harnessId, cwd, sessionPath })
    if (!open.ok || !open.runId) {
      // Surface the reason as a system message.
      set((s) => ({
        session: s.session
          ? {
              ...s.session,
              messages: [
                ...s.session.messages,
                { id: `sys-${Date.now()}`, role: 'system', text: `⚠ ${open.reason ?? 'Could not open agent.'}` }
              ]
            }
          : s.session
      }))
      return false
    }

    const runId = open.runId
    if (midStream) {
      const res = await heph.agentSend({ runId, text: sentText, behavior: behavior ?? 'followUp' })
      if (!res.ok) {
        set((s) => ({
          notices: [
            ...s.notices,
            {
              id: `err-${Date.now()}`,
              message: res.reason ?? 'Could not queue that message.',
              kind: 'error'
            }
          ]
        }))
        return false
      }
      return true
    }

    set((s) => {
      // Drop any stale run for the same target (e.g. a prior errored or idle run
      // for this session) so exactly one run matches the viewed session.
      const runs: Record<string, RunMeta> = {}
      const streams: Record<string, RunStream> = { ...s.streams }
      for (const [id, r] of Object.entries(s.runs)) {
        const sameTarget = sessionPath
          ? samePath(r.sessionPath, sessionPath)
          : !r.sessionPath && samePath(r.cwd, cwd)
        if (sameTarget) delete streams[id]
        else runs[id] = r
      }
      runs[runId] = {
        runId,
        harnessId,
        cwd,
        sessionPath: sessionPath ?? null,
        status: 'running',
        startedAt: Date.now()
      }
      streams[runId] = { text: '', thinking: '', rev: 0 }
      return { runs, streams }
    })
    const res = await heph.agentSend({ runId, text: sentText })
    if (!res.ok) {
      set((s) => ({
        notices: [
          ...s.notices,
          { id: `err-${Date.now()}`, message: res.reason ?? 'Could not send.', kind: 'error' }
        ]
      }))
      return false
    }
    return true
  },

  answerPrompt: async (id, response) => {
    const p = get().pendingPrompts[id]
    if (!p) return
    // Remove first so the card can't be double-submitted while the write is in
    // flight; the driver matches the response to the request by its id.
    set((s) => {
      const rest = { ...s.pendingPrompts }
      delete rest[id]
      return { pendingPrompts: rest }
    })
    try {
      await heph.agentRespond({ runId: p.runId, response })
    } catch {
      // ignore — a dead run surfaces via its error/exit events
    }
  },

  dismissNotice: (id) => set((s) => ({ notices: s.notices.filter((n) => n.id !== id) })),

  takeDraftRestore: () => {
    const text = get().draftRestore
    if (text) set({ draftRestore: null })
    return text
  },

  abortRetry: async () => {
    const runId = selectCurrentRunId(get())
    if (!runId) return
    await heph.agentAbortRetry(runId)
  },

  restartRun: async (runId) => {
    // Close the wedged process and drop its local state; the next prompt spawns a
    // fresh one via agentOpen.
    try {
      await heph.agentClose(runId)
    } catch {
      // ignore — it may already be gone
    }
    lastSeq.delete(runId)
    set((s) => {
      const runs = { ...s.runs }
      const streams = { ...s.streams }
      const statsLive = { ...s.statsLive }
      delete runs[runId]
      delete streams[runId]
      delete statsLive[runId]
      return {
        runs,
        streams,
        statsLive,
        pendingPrompts: Object.fromEntries(
          Object.entries(s.pendingPrompts).filter(([, p]) => p.runId !== runId)
        )
      }
    })
  },

  patchSessionSummary: (projectEncoded, summary) => {
    let known = false
    set((s) => {
      const idx = s.projects.findIndex((p) => p.encoded === projectEncoded)
      if (idx < 0) return {}
      known = true
      const project = s.projects[idx]
      const at = project.sessions.findIndex((x) => samePath(x.path, summary.path))
      // Nothing to repaint if the row is byte-for-byte what we already show.
      if (at >= 0) {
        const prev = project.sessions[at]
        if (
          prev.title === summary.title &&
          prev.messageCount === summary.messageCount &&
          prev.totalTokens === summary.totalTokens &&
          prev.timestamp === summary.timestamp
        ) {
          return {}
        }
      }
      const sessions = [...project.sessions]
      if (at >= 0) sessions[at] = summary
      else sessions.push(summary)
      sessions.sort((a, b) => (a.timestamp < b.timestamp ? 1 : -1))

      const projects = [...s.projects]
      projects[idx] = { ...project, sessions }
      // Keep most-recently-active projects first, matching listProjects' order.
      projects.sort((a, b) => {
        const ta = a.sessions[0]?.timestamp ?? ''
        const tb = b.sessions[0]?.timestamp ?? ''
        return ta < tb ? 1 : -1
      })
      return { projects }
    })
    // The session belongs to a project the sidebar hasn't listed yet.
    if (!known) {
      const view = get().view
      if (view !== 'dashboard') void get().loadProjects(view.harnessId)
    }
  },

  abort: async () => {
    const runId = selectCurrentRunId(get())
    if (!runId) return
    await heph.agentAbort(runId)
    // Read the run *inside* the update rather than reusing the copy captured
    // before the await: batches can land while the abort is in flight, and writing
    // back the stale object would silently drop that text. Streams are left
    // untouched for the same reason.
    set((s) => {
      const run = s.runs[runId]
      const rest = Object.fromEntries(
        Object.entries(s.pendingPrompts).filter(([, p]) => p.runId !== runId)
      )
      if (!run) return { pendingPrompts: rest }
      return { runs: { ...s.runs, [runId]: { ...run, status: 'idle' } }, pendingPrompts: rest }
    })
  },

  applySessionUpdate: async (payload) => {
    const { view } = get()
    if (view === 'dashboard') return
    // A path-only call (from session_bound) has no summary yet; treat it as a
    // change to that file with unknown metadata.
    const { path, summary, projectEncoded, isNew } =
      typeof payload === 'string'
        ? { path: payload, summary: null, projectEncoded: null, isNew: true }
        : payload

    // Patch the one project row that changed. Re-listing the whole harness here is
    // what used to re-read and re-parse every session file of every project,
    // several times a second, on the same thread that pumps the agent's output.
    if (summary && projectEncoded) {
      get().patchSessionSummary(projectEncoded, summary)
    } else if (isNew) {
      // A brand-new session (or an unreadable one) can imply a project we don't
      // know about yet, which only a full listing can discover.
      void get().loadProjects(view.harnessId)
    }

    const { selectedSessionPath, selectedCwd } = get()
    // A new chat has no session path yet, so a file appearing in *this project* is
    // how it gets adopted. Requiring the project to match matters: without it every
    // session file that changed anywhere in the harness was fully re-parsed and
    // loaded while a new chat was open.
    const adoptable =
      selectedSessionPath === null && selectedCwd != null && samePath(summary?.cwd, selectedCwd)
    const viewing = samePath(path, selectedSessionPath) || adoptable

    // While *our* run is streaming this session, the stream is the source of truth
    // and the file lags behind it — reloading per tick would re-parse the thread
    // repeatedly only to show text we already have. One authoritative reload
    // happens at end of turn (finalizeRun), and a `finalizing` run still reloads
    // here so an external writer (or a missed finalize) still reconciles.
    const ownStreaming = Object.values(get().runs).some(
      (r) => r.status === 'running' && samePath(r.sessionPath, path)
    )

    if (viewing && !ownStreaming) {
      let session: SessionDetail
      try {
        session = await heph.loadSession(view.harnessId, path)
      } catch {
        // The file may not be fully written yet (e.g. a just-bound new session);
        // a later watcher event will reload it.
        return
      }
      const headerCwd = session.header.cwd ?? ''
      if (selectedSessionPath === null) {
        if (samePath(headerCwd, selectedCwd)) set({ session, selectedSessionPath: path })
      } else {
        set({ session })
      }
      // Bind any pathless run for this cwd to the now-known session path.
      set((s) => {
        const runs = { ...s.runs }
        let changed = false
        for (const [id, r] of Object.entries(runs)) {
          if (!r.sessionPath && samePath(r.cwd, headerCwd)) {
            runs[id] = { ...r, sessionPath: path }
            changed = true
          }
        }
        return changed ? { runs } : {}
      })
    } else if (summary?.cwd) {
      // Not reloading the thread, but still bind pathless runs so a new chat
      // adopts its session file as soon as the harness creates it.
      set((s) => {
        const runs = { ...s.runs }
        let changed = false
        for (const [id, r] of Object.entries(runs)) {
          if (!r.sessionPath && samePath(r.cwd, summary.cwd)) {
            runs[id] = { ...r, sessionPath: path }
            changed = true
          }
        }
        return changed ? { runs } : {}
      })
    }

    // Reconcile: retire a finalizing run for this session only once its reply is
    // actually on disk (last message is an assistant turn), so the streamed text
    // is never dropped before the authoritative bubble can replace it.
    const reloaded = get().session
    const last = reloaded?.messages[reloaded.messages.length - 1]
    const replyLanded =
      !!last && last.role === 'assistant' && samePath(reloaded?.path, path)
    if (replyLanded) {
      set((s) => {
        const runs = { ...s.runs }
        const streams = { ...s.streams }
        let changed = false
        for (const [id, r] of Object.entries(runs)) {
          if (samePath(r.sessionPath, path) && r.status === 'finalizing') {
            delete runs[id]
            delete streams[id]
            lastSeq.delete(id)
            changed = true
          }
        }
        return changed ? { runs, streams } : {}
      })
    }
  },

  applyAgentBatch: (b) => {
    const runId = b.runId
    if (!runId) return

    // Ordered + monotonic: anything we've already applied is a duplicate, and a
    // skipped seq means we lost a batch and should rebuild from the registry.
    const prev = lastSeq.get(runId) ?? 0
    if (b.seq <= prev) return
    const gap = prev > 0 && b.seq > prev + 1
    lastSeq.set(runId, b.seq)

    // Split the batch once: text/thinking accumulate, events are folded in order.
    let text = ''
    let thinking = ''
    const events: AgentStreamEvent[] = []
    let isWork = false
    for (const it of b.items) {
      if (it.kind === 'text') {
        text += it.text
        isWork = true
      } else if (it.kind === 'thinking') {
        thinking += it.text
        isWork = true
      } else {
        events.push(it.event)
        // Only genuine output may create a run. Trailing/meta events —
        // display-only extension status, late responses — must NOT resurrect a
        // run that finalizeRun already retired, or the working indicator would
        // restart with no agent_end ever coming. An interactive prompt counts as
        // work: the turn paused mid-flight to ask the user something.
        if (
          it.event.type === 'tool_execution_start' ||
          it.event.type === 'tool_execution_update' ||
          it.event.type === 'extension_ui_request'
        ) {
          isWork = true
        }
      }
    }

    // One commit for the whole batch. `runs` and `streams` are written
    // independently so a pure-text batch leaves the `runs` identity untouched and
    // only the live row re-renders.
    set((s) => {
      const existing = s.runs[runId]
      if (!existing && !isWork) return {}

      const next: RunMeta = existing
        ? { ...existing }
        : {
            runId,
            harnessId: b.harnessId,
            cwd: b.cwd,
            sessionPath: b.sessionPath ?? null,
            status: 'running',
            startedAt: Date.now()
          }
      if (b.cwd && !next.cwd) next.cwd = b.cwd
      if (b.sessionPath && !next.sessionPath) next.sessionPath = b.sessionPath
      if (isWork && isActive(next.status)) next.status = 'running'
      for (const e of events) applyEventToRun(next, e)

      const patch: Partial<State> = {}
      if (!existing || !shallowEqualMeta(existing, next)) {
        patch.runs = { ...s.runs, [runId]: next }
      }
      if (text || thinking) {
        const prevStream = s.streams[runId] ?? EMPTY_STREAM
        patch.streams = {
          ...s.streams,
          [runId]: {
            text: text ? prevStream.text + text : prevStream.text,
            thinking: thinking ? prevStream.thinking + thinking : prevStream.thinking,
            rev: prevStream.rev + 1
          }
        }
      }
      return patch
    })

    if (gap) void get().resyncRuns()

    // The tool stream names the file the agent is writing *before* the write lands,
    // so the tree can flash immediately; the filesystem watcher independently
    // refreshes the content a moment later.
    const runCwd = get().runs[runId]?.cwd ?? b.cwd
    const edited = collectEditedPaths(events, runCwd)
    if (edited.length) {
      set((s) => {
        const now = Date.now()
        const agentEdits = { ...s.agentEdits }
        for (const p of edited) agentEdits[p] = now
        // Keep the map from growing without bound over a long session.
        const keys = Object.keys(agentEdits)
        if (keys.length > 200) {
          for (const k of keys) if (now - agentEdits[k] > AGENT_EDIT_TTL_MS) delete agentEdits[k]
        }
        return { agentEdits }
      })
      // The same paths feed the reference index, and this — not the watcher — is the
      // path that matters: the watcher only descends three levels, shallower than
      // most source trees, whereas a tool's `path` argument names the file at any
      // depth. Guarded on the selection, since the index is per-open-project while a
      // run can be for any of them.
      if (samePath(get().selectedCwd, runCwd)) {
        patchProjectIndex(runCwd, { add: edited }, set, get)
      }
    }

    // Stats are applied whether or not the run still exists: the authoritative
    // end-of-turn totals arrive just after `agent_end`, by which point the run may
    // already have been retired.
    const statsPatches = events.filter((e) => e.type === 'stats')
    if (statsPatches.length) {
      set((s) => {
        let live = s.statsLive[runId] ?? {}
        let final: StatsPatch | null = null
        for (const e of statsPatches) {
          if (e.type !== 'stats') continue
          live = mergeStats(live, e.patch)
          if (e.patch.final) final = live
        }
        const patch: Partial<State> = { statsLive: { ...s.statsLive, [runId]: live } }
        const sessionPath = b.sessionPath ?? s.runs[runId]?.sessionPath
        if (final && sessionPath) {
          patch.sessionStats = {
            ...s.sessionStats,
            [sessionPath]: mergeStats(s.sessionStats[sessionPath] ?? {}, final)
          }
        }
        return patch
      })
    }

    // Side effects, in stream order.
    let finalize = false
    let boundPath: string | null = null
    for (const e of events) {
      switch (e.type) {
        case 'extension_ui_request': {
          // Blocking methods become a pending prompt card; `notify` is a
          // transient, no-response notice.
          const ui = e.ui
          if (ui.method === 'notify') {
            set((s) => ({
              notices: [
                ...s.notices,
                { id: ui.id, message: ui.message, kind: ui.notifyType ?? 'info' }
              ]
            }))
          } else {
            const run = get().runs[runId]
            const pending: PendingPrompt = {
              id: ui.id,
              runId,
              cwd: b.cwd || run?.cwd || '',
              sessionPath: b.sessionPath ?? run?.sessionPath ?? null,
              request: ui
            }
            set((s) => ({ pendingPrompts: { ...s.pendingPrompts, [ui.id]: pending } }))
          }
          break
        }

        case 'ui_cancelled':
          // The prompt timed out harness-side; it can no longer be answered.
          set((s) => {
            if (!s.pendingPrompts[e.id]) return {}
            const rest = { ...s.pendingPrompts }
            delete rest[e.id]
            return { pendingPrompts: rest }
          })
          break

        case 'stream_error':
          set((s) => ({
            notices: [
              ...s.notices,
              { id: `err-${Date.now()}-${s.notices.length}`, message: e.reason, kind: 'error' }
            ]
          }))
          break

        case 'prompt_rejected':
          // The harness refused the prompt, so it never reached the agent. Take the
          // optimistic bubble back off the thread and hand the text back to the
          // composer — losing what someone typed is the worst possible outcome here.
          set((s) => {
            const notices = [
              ...s.notices,
              { id: `err-${Date.now()}-${s.notices.length}`, message: e.reason, kind: 'error' as const }
            ]
            if (!s.session) return { notices }
            const messages = [...s.session.messages]
            let restored = ''
            while (messages.length && messages[messages.length - 1].id.startsWith('local-')) {
              restored = messages.pop()?.text ?? restored
            }
            return {
              notices,
              session: { ...s.session, messages },
              draftRestore: restored || s.draftRestore
            }
          })
          break

        case 'session_bound':
          boundPath = e.sessionPath
          break

        case 'agent_end':
        case 'agent_settled':
          finalize = true
          break

        case 'session_info_changed':
          // The harness renamed the session; reflect it in the header.
          if (e.name) {
            set((s) =>
              s.session ? { session: { ...s.session, name: e.name } } : {}
            )
          }
          break

        case 'error': {
          // Surface full detail (reason + stderr tail) inline on the viewed session.
          const detail = `${e.errorReason}${e.stderrTail ? `\n\n${e.stderrTail}` : ''}`
          set((s) => {
            const run = s.runs[runId]
            const viewing =
              run &&
              (samePath(run.sessionPath, s.selectedSessionPath) ||
                (s.selectedSessionPath === null && samePath(run.cwd, s.selectedCwd)))
            if (!viewing || !s.session) return {}
            return {
              session: {
                ...s.session,
                messages: [
                  ...s.session.messages,
                  { id: `sys-${Date.now()}`, role: 'system', text: `⚠ ${detail}` }
                ]
              }
            }
          })
          break
        }

        default:
          break
      }

      // The turn ended (cleanly, by error, or process exit) — any prompt it was
      // blocked on can no longer be answered.
      if (e.type === 'agent_end' || e.type === 'error' || e.type === 'agent_exit') {
        set((s) => {
          const kept = Object.entries(s.pendingPrompts).filter(([, p]) => p.runId !== runId)
          if (kept.length === Object.keys(s.pendingPrompts).length) return {}
          return { pendingPrompts: Object.fromEntries(kept) }
        })
      }
    }

    if (boundPath) {
      // The harness revealed the new session's file path (and it now exists on
      // disk). Navigate to it immediately using this run's own cwd — more robust
      // than matching the file's header cwd — then load details + refresh the
      // sidebar via applySessionUpdate.
      const st = get()
      const run = st.runs[runId]
      if (st.selectedSessionPath === null && run && samePath(st.selectedCwd, run.cwd)) {
        set({ selectedSessionPath: boundPath })
      }
      void get().applySessionUpdate(boundPath)
    }

    if (finalize) {
      // Deterministically swap the streamed text for the authoritative session
      // and retire the run — rather than racing the file watcher / a timer,
      // which could drop the text before the reload repaints it.
      void get().finalizeRun(runId)
    }
  },

  finalizeRun: async (runId, attempt = 0) => {
    const { view } = get()
    if (view === 'dashboard') return
    const run = get().runs[runId]
    if (!run) return
    // Called only from `agent_end` / `agent_settled`. `finalizing` means the whole
    // run is done; `running` at this point means a queued turn just ended and
    // another follows, so the finished turn is swapped in for the authoritative
    // version but the run stays alive.
    const continuing = run.status === 'running'
    if (!continuing && run.status !== 'finalizing') return

    // Without a known session path (a brand-new chat not yet adopted) we can't
    // load the authoritative file; leave the settled stream visible and let the
    // session watcher's adoption pass reconcile it. The text stays on screen.
    const sessionPath = run.sessionPath
    if (!sessionPath) return

    let session: SessionDetail | null = null
    try {
      session = await heph.loadSession(view.harnessId, sessionPath)
    } catch {
      session = null
    }

    // Only retire the run (and swap in the authoritative session) once the reply
    // is actually present (last message is an assistant turn). Until then the
    // streamed text stays on screen — it is never dropped before its replacement
    // exists. The harness appends the message synchronously around agent_end, so
    // one retry covers the flush race; beyond that the session watcher's own
    // `replyLanded` reconciliation retires the run, rather than us re-parsing the
    // whole file another six times.
    const last = session?.messages[session.messages.length - 1]
    const replyLanded = !!session && !!last && last.role === 'assistant'

    if (!replyLanded) {
      if (attempt < 1) setTimeout(() => void get().finalizeRun(runId, attempt + 1), 750)
      return
    }

    const st = get()
    const isViewed =
      samePath(st.selectedSessionPath, sessionPath) ||
      (st.selectedSessionPath === null && samePath(st.selectedCwd, run.cwd))

    if (!continuing) lastSeq.delete(runId)
    set((s) => {
      const runs = { ...s.runs }
      const streams = { ...s.streams }
      const statsLive = { ...s.statsLive }
      const live = statsLive[runId]
      if (continuing) {
        // A queued turn follows. Keep the run, but reset its buffer so the next
        // turn's text doesn't render appended to the one we just settled.
        streams[runId] = { text: '', thinking: '', rev: (s.streams[runId]?.rev ?? 0) + 1 }
      } else {
        delete runs[runId]
        delete streams[runId]
        delete statsLive[runId]
      }

      // The file's own tokens/sec is derived from record timestamps, which is
      // coarse. We just watched this turn happen, so prefer the rate we measured
      // (or the provider reported) for its last assistant message.
      let authoritative = session as SessionDetail
      if (live?.tokPerSec && authoritative.messages.length) {
        const messages = [...authoritative.messages]
        for (let i = messages.length - 1; i >= 0; i--) {
          if (messages[i].role === 'assistant') {
            messages[i] = { ...messages[i], tps: live.tokPerSec, tpsApprox: live.approx }
            break
          }
        }
        authoritative = { ...authoritative, messages }
      }

      const patch: Partial<State> = { runs, streams, statsLive }
      if (isViewed) {
        patch.session = authoritative
        patch.selectedSessionPath = sessionPath
      }
      return patch
    })
  },

  resyncRuns: async () => {
    set({ reconnecting: true })
    try {
      const snaps = await heph.agentListRuns()
      set((s) => {
        const runs: Record<string, RunMeta> = {}
        const streams: Record<string, RunStream> = {}
        // Preserve local transient runs: finalizing (awaiting authoritative
        // reload) and error (shown inline). These take precedence over whatever
        // the registry reports for the same id.
        for (const [id, r] of Object.entries(s.runs)) {
          if (r.status === 'finalizing' || r.status === 'error') {
            runs[id] = r
            if (s.streams[id]) streams[id] = s.streams[id]
          }
        }
        // Adopt only *active* runs from the source of truth. Inactive (idle)
        // registry runs are dropped, and local active runs the registry no longer
        // knows about disappear — that's what un-sticks a disconnected UI.
        for (const snap of snaps) {
          if (!isActive(snap.status)) continue
          if (runs[snap.runId]) continue
          runs[snap.runId] = snapshotToMeta(snap)
          // Keep whichever accumulation is longer — we may have streamed past the
          // bounded snapshot tail, or the snapshot may be ahead of us (e.g. after
          // a renderer reload, where we have no local copy at all).
          const prev = s.streams[snap.runId] ?? EMPTY_STREAM
          streams[snap.runId] = {
            text: prev.text.length >= snap.streamTail.length ? prev.text : snap.streamTail,
            thinking:
              prev.thinking.length >= snap.thinkingTail.length ? prev.thinking : snap.thinkingTail,
            rev: prev.rev + 1
          }
        }
        // Rehydrate any in-flight prompt so a reloaded renderer isn't stranded
        // on a paused turn it can no longer answer.
        const pendingPrompts = { ...s.pendingPrompts }
        for (const snap of snaps) {
          const ui = snap.pendingUi
          if (ui && ui.method !== 'notify' && !pendingPrompts[ui.id]) {
            pendingPrompts[ui.id] = {
              id: ui.id,
              runId: snap.runId,
              cwd: snap.cwd,
              sessionPath: snap.sessionPath,
              request: ui
            }
          }
        }
        return { runs, streams, pendingPrompts }
      })
    } catch {
      // ignore — best effort
    } finally {
      set({ reconnecting: false })
    }
  }
  }
})
