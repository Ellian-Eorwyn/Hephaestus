import { create } from 'zustand'
import type {
  HarnessConfig,
  ProjectSummary,
  SessionDetail,
  FileNode,
  FileContent,
  BackendHealth,
  AgentEvent,
  RunStatus,
  RunSnapshot,
  ThreadMessage
} from '@shared/types'
import { wrapWithViewingContext } from '@shared/viewing-context'

const heph = window.heph

type View = 'dashboard' | { harnessId: string }

/** Renderer-side mirror of a main-process run, with accumulated stream text. */
export interface RunState {
  runId: string
  harnessId: string
  cwd: string
  sessionPath: string | null
  status: RunStatus
  currentTool?: string
  startedAt: number
  /** Accumulated visible stream for this run. */
  text: string
  /** Accumulated reasoning stream for this run. */
  thinking: string
  error?: string
}

const ACTIVE: RunStatus[] = ['starting', 'running', 'finalizing']
export function isActive(status: RunStatus): boolean {
  return ACTIVE.includes(status)
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
 * The run feeding the currently-viewed session: matched by sessionPath when a
 * session is selected, or — for a brand-new chat not yet written to disk — the
 * pathless run for the selected cwd.
 */
export function selectCurrentRun(s: {
  runs: Record<string, RunState>
  selectedSessionPath: string | null
  selectedCwd: string | null
}): RunState | null {
  const list = Object.values(s.runs)
  if (s.selectedSessionPath) {
    return list.find((r) => samePath(r.sessionPath, s.selectedSessionPath)) ?? null
  }
  if (s.selectedCwd) {
    return list.find((r) => !r.sessionPath && samePath(r.cwd, s.selectedCwd) && isActive(r.status)) ?? null
  }
  return null
}

function snapshotToRun(s: RunSnapshot): RunState {
  return {
    runId: s.runId,
    harnessId: s.harnessId,
    cwd: s.cwd,
    sessionPath: s.sessionPath,
    status: s.status,
    currentTool: s.currentTool,
    startedAt: s.startedAt,
    text: s.streamTail,
    thinking: s.thinkingTail,
    error: s.error
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
  runs: Record<string, RunState>
  /** True while a resync (agentListRuns) is in flight, for the reconnect chip. */
  reconnecting: boolean

  // inspector
  fileTree: FileNode[]
  selectedFile: string | null
  fileContent: FileContent | null
  /** When true, the file being viewed is silently attached to the next prompt. */
  attachViewedFile: boolean

  // status
  backend: Record<string, BackendHealth>

  // actions
  init: () => Promise<void>
  setView: (v: View) => void
  toggleTheme: () => void
  toggleZen: () => void
  setAddModal: (open: boolean) => void

  // settings
  settingsModalOpen: boolean
  messageSpacing: 'compact' | 'cozy' | 'comfortable'
  showThinking: boolean
  showTools: boolean
  showToolResults: boolean
  autoAttachFile: boolean
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
      reduceMotion: boolean
    }>
  ) => void

  addHarness: (input: { label: string; agentDir: string }) => Promise<void>

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
  selectFile: (path: string) => Promise<void>
  refreshFiles: () => Promise<void>
  setAttachViewedFile: (on: boolean) => void
  refreshBackend: (harnessId: string) => Promise<void>
  addProject: (cwd: string) => Promise<void>
  browseAndAddProject: () => Promise<void>

  sendPrompt: (text: string) => Promise<void>
  abort: () => Promise<void>
  applySessionUpdate: (path: string) => Promise<void>
  applyAgentEvent: (e: AgentEvent) => void
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

    settingsModalOpen: false,
    messageSpacing: settings.messageSpacing || 'compact',
    showThinking: settings.showThinking ?? true,
    showTools: settings.showTools ?? true,
    showToolResults: settings.showToolResults ?? true,
    autoAttachFile: settings.autoAttachFile ?? true,
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
  reconnecting: false,

  fileTree: [],
  selectedFile: null,
  fileContent: null,
  attachViewedFile: settings.autoAttachFile ?? true,

  backend: {},

  init: async () => {
    document.documentElement.setAttribute('data-theme', get().theme)
    document.documentElement.setAttribute('data-reduce-motion', String(get().reduceMotion))
    const harnesses = await heph.listHarnesses()
    set({ harnesses })

    // Live session updates -> refresh open session if it changed.
    heph.onSessionUpdated(({ path }) => {
      void get().applySessionUpdate(path)
    })
    heph.onAgentEvent((e) => get().applyAgentEvent(e))
    heph.onProjectChanged((cwd) => {
      if (samePath(get().selectedCwd, cwd)) {
        heph.listFiles(cwd).then((fileTree) => set({ fileTree })).catch(() => {})
      }
    })

    // Reconnect to any in-flight runs now (survives renderer reloads) and again
    // whenever the window regains focus, so a stale/disconnected UI self-heals
    // without a relaunch.
    void get().resyncRuns()
    window.addEventListener('focus', () => void get().resyncRuns())
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible') void get().resyncRuns()
    })

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
    set({
      selectedCwd: cwd,
      selectedSessionPath: null,
      session: null
    })
    try {
      void heph.watchProject(cwd)
      const fileTree = await heph.listFiles(cwd)
      set({ fileTree, selectedFile: null, fileContent: null })
    } catch {
      set({ fileTree: [], selectedFile: null, fileContent: null })
    }
  },

  startNewChat: async (cwd) => {
    set({
      selectedCwd: cwd,
      selectedSessionPath: null,
      session: null
    })
    try {
      void heph.watchProject(cwd)
      const fileTree = await heph.listFiles(cwd)
      set({ fileTree, selectedFile: null, fileContent: null })
    } catch {
      set({ fileTree: [], selectedFile: null, fileContent: null })
    }
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
    set({ selectedSessionPath: path, selectedCwd: cwd, loadingSession: true })
    const session = await heph.loadSession(harnessId, path)
    set({ session, loadingSession: false })
    // Load the file tree for this project's cwd.
    try {
      void heph.watchProject(cwd)
      const fileTree = await heph.listFiles(cwd)
      set({ fileTree, selectedFile: null, fileContent: null })
    } catch {
      set({ fileTree: [], selectedFile: null, fileContent: null })
    }
  },

  selectFile: async (path) => {
    // Opening a new file applies the auto-attach default (Settings).
    set({ selectedFile: path, attachViewedFile: get().autoAttachFile })
    try {
      const fileContent = await heph.readFile(path)
      set({ fileContent })
    } catch {
      set({ fileContent: null })
    }
  },

  refreshFiles: async () => {
    const cwd = get().selectedCwd
    if (!cwd) return
    try {
      void heph.watchProject(cwd)
      const fileTree = await heph.listFiles(cwd)
      set({ fileTree })
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

  sendPrompt: async (text) => {
    const harnessId = get().activeHarnessId()
    const cwd = get().selectedCwd
    if (!harnessId || !cwd) return

    // If a file is open and auto-attach is on, silently tell the agent which
    // file the user is looking at so references like "this" resolve. The chat
    // bubble keeps showing only the typed text (plus an attachment chip).
    const file = get().selectedFile
    const attach = get().attachViewedFile && !!file
    const sentText = attach ? wrapWithViewingContext(text, file as string) : text

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
      return
    }

    const runId = open.runId
    set((s) => {
      // Drop any stale run for the same target (e.g. a prior errored or idle run
      // for this session) so exactly one run matches the viewed session.
      const runs: Record<string, RunState> = {}
      for (const [id, r] of Object.entries(s.runs)) {
        const sameTarget = sessionPath
          ? samePath(r.sessionPath, sessionPath)
          : !r.sessionPath && samePath(r.cwd, cwd)
        if (!sameTarget) runs[id] = r
      }
      runs[runId] = {
        runId,
        harnessId,
        cwd,
        sessionPath: sessionPath ?? null,
        status: 'running',
        startedAt: Date.now(),
        text: '',
        thinking: ''
      }
      return { runs }
    })
    await heph.agentSend({ runId, text: sentText })
  },

  abort: async () => {
    const run = selectCurrentRun(get())
    if (!run) return
    await heph.agentAbort(run.runId)
    set((s) => ({ runs: { ...s.runs, [run.runId]: { ...run, status: 'idle' } } }))
  },

  applySessionUpdate: async (path) => {
    const { view } = get()
    if (view === 'dashboard') return

    // Re-fetch project list so the sidebar shows the new/updated session.
    void get().loadProjects(view.harnessId)

    const { selectedSessionPath, selectedCwd } = get()
    const viewing =
      samePath(path, selectedSessionPath) || (selectedSessionPath === null && selectedCwd != null)

    if (viewing) {
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
        let changed = false
        for (const [id, r] of Object.entries(runs)) {
          if (samePath(r.sessionPath, path) && r.status === 'finalizing') {
            delete runs[id]
            changed = true
          }
        }
        return changed ? { runs } : {}
      })
    }
  },

  applyAgentEvent: (e) => {
    const runId = e.runId
    if (!runId) return
    const { type } = e

    // Only actual output (deltas/tool activity) may create a run. Trailing/meta
    // events — late get_state responses, post-completion notices — must NOT
    // resurrect a run that finalizeRun already retired, or the working indicator
    // would restart with no agent_end ever coming.
    const isWork = !!(e.delta || e.thinkingDelta || e.toolName)

    set((s) => {
      const prev = s.runs[runId]
      if (!prev && !isWork) return {}
      const next: RunState = prev
        ? { ...prev }
        : {
            runId,
            harnessId: e.harnessId,
            cwd: e.cwd ?? '',
            sessionPath: e.sessionPath ?? null,
            status: 'running',
            startedAt: Date.now(),
            text: '',
            thinking: ''
          }
      if (e.cwd && !next.cwd) next.cwd = e.cwd
      if (e.sessionPath && !next.sessionPath) next.sessionPath = e.sessionPath
      if (e.delta) next.text += e.delta
      if (e.thinkingDelta) next.thinking += e.thinkingDelta
      if (e.toolName) next.currentTool = e.toolName
      if (isActive(next.status) && (e.delta || e.thinkingDelta || e.toolName)) next.status = 'running'

      if (type === 'agent_end') {
        next.status = 'finalizing'
        next.currentTool = undefined
      } else if (type === 'agent_exit') {
        if (next.status !== 'error' && next.status !== 'finalizing') next.status = 'idle'
      } else if (type === 'error') {
        next.status = 'error'
        next.error = e.errorReason ?? 'Run failed.'
      }

      return { runs: { ...s.runs, [runId]: next } }
    })

    if (type === 'session_bound' && e.sessionPath) {
      // The harness revealed the new session's file path (and it now exists on
      // disk). Navigate to it immediately using this run's own cwd — more robust
      // than matching the file's header cwd — then load details + refresh the
      // sidebar via applySessionUpdate.
      const path = e.sessionPath
      const st = get()
      const run = st.runs[runId]
      if (st.selectedSessionPath === null && run && samePath(st.selectedCwd, run.cwd)) {
        set({ selectedSessionPath: path })
      }
      void get().applySessionUpdate(path)
    }

    if (type === 'agent_end') {
      // Deterministically swap the streamed text for the authoritative session
      // and retire the run — rather than racing the file watcher / a timer,
      // which could drop the text before the reload repaints it.
      void get().finalizeRun(runId)
    }

    if (type === 'error') {
      // Surface full detail (reason + stderr tail) inline on the viewed session.
      const detail = `${e.errorReason ?? 'Run failed.'}${e.stderrTail ? `\n\n${e.stderrTail}` : ''}`
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
    }
  },

  finalizeRun: async (runId, attempt = 0) => {
    const { view } = get()
    if (view === 'dashboard') return
    const run = get().runs[runId]
    if (!run || run.status !== 'finalizing') return

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
    // exists. The harness writes the message just before/around agent_end, so a
    // couple of short retries cover the file-flush race without trusting the
    // watcher alone.
    const last = session?.messages[session.messages.length - 1]
    const replyLanded = !!session && !!last && last.role === 'assistant'

    if (!replyLanded) {
      if (attempt < 6) setTimeout(() => void get().finalizeRun(runId, attempt + 1), 500)
      return
    }

    const st = get()
    const isViewed =
      samePath(st.selectedSessionPath, sessionPath) ||
      (st.selectedSessionPath === null && samePath(st.selectedCwd, run.cwd))

    set((s) => {
      const runs = { ...s.runs }
      delete runs[runId]
      return isViewed
        ? { runs, session: session as SessionDetail, selectedSessionPath: sessionPath }
        : { runs }
    })
  },

  resyncRuns: async () => {
    set({ reconnecting: true })
    try {
      const snaps = await heph.agentListRuns()
      set((s) => {
        const runs: Record<string, RunState> = {}
        // Preserve local transient runs: finalizing (awaiting authoritative
        // reload) and error (shown inline). These take precedence over whatever
        // the registry reports for the same id.
        for (const [id, r] of Object.entries(s.runs)) {
          if (r.status === 'finalizing' || r.status === 'error') runs[id] = r
        }
        // Adopt only *active* runs from the source of truth. Inactive (idle)
        // registry runs are dropped, and local active runs the registry no longer
        // knows about disappear — that's what un-sticks a disconnected UI.
        for (const snap of snaps) {
          if (!isActive(snap.status)) continue
          if (runs[snap.runId]) continue
          const fresh = snapshotToRun(snap)
          const prev = s.runs[snap.runId]
          if (prev) {
            // Keep whichever accumulation is longer — we may have streamed past
            // the bounded snapshot tail, or the snapshot may be ahead of us.
            if (prev.text.length >= fresh.text.length) fresh.text = prev.text
            if (prev.thinking.length >= fresh.thinking.length) fresh.thinking = prev.thinking
          }
          runs[snap.runId] = fresh
        }
        return { runs }
      })
    } catch {
      // ignore — best effort
    } finally {
      set({ reconnecting: false })
    }
  }
  }
})
