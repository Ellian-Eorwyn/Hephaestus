import { create } from 'zustand'
import type {
  HarnessConfig,
  ProjectSummary,
  SessionDetail,
  FileNode,
  FileContent,
  BackendHealth,
  AgentEvent,
  ThreadMessage
} from '@shared/types'
import { wrapWithViewingContext } from '@shared/viewing-context'

const heph = window.heph

type View = 'dashboard' | { harnessId: string }

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
    showToolResults: true
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

  // streaming
  agentStatus: 'idle' | 'running'
  streamingText: string
  streamingThinking: string

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
  setSettingsModalOpen: (open: boolean) => void
  updateSettings: (
    updates: Partial<{
      messageSpacing: 'compact' | 'cozy' | 'comfortable'
      showThinking: boolean
      showTools: boolean
      showToolResults: boolean
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
  setAttachViewedFile: (on: boolean) => void
  refreshBackend: (harnessId: string) => Promise<void>
  addProject: (cwd: string) => Promise<void>
  browseAndAddProject: () => Promise<void>

  sendPrompt: (text: string) => Promise<void>
  abort: () => Promise<void>
  applySessionUpdate: (path: string) => Promise<void>
  applyAgentEvent: (e: AgentEvent) => void
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

    projects: [],
  expanded: {},
  selectedCwd: null,

  archived: loadArchived(),
  selectionMode: false,
  selectedForArchive: [],

  selectedSessionPath: null,
  session: null,
  loadingSession: false,

  agentStatus: 'idle',
  streamingText: '',
  streamingThinking: '',

  fileTree: [],
  selectedFile: null,
  fileContent: null,
  attachViewedFile: true,

  backend: {},

  init: async () => {
    document.documentElement.setAttribute('data-theme', get().theme)
    const harnesses = await heph.listHarnesses()
    set({ harnesses })

    // Live session updates -> refresh open session if it changed.
    heph.onSessionUpdated(({ path }) => {
      void get().applySessionUpdate(path)
    })
    heph.onAgentEvent((e) => get().applyAgentEvent(e))
    heph.onProjectChanged((cwd) => {
      if (get().selectedCwd === cwd) {
        heph.listFiles(cwd).then((fileTree) => set({ fileTree })).catch(() => {})
      }
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
      set({
        selectedSessionPath: null,
        session: null,
        selectedCwd: null,
        fileTree: [],
        selectedFile: null,
        fileContent: null,
        agentStatus: 'idle',
        streamingText: '',
        streamingThinking: ''
      })
    }
    if (nextId) void get().loadProjects(nextId)
  },

  toggleTheme: () => {
    const theme = get().theme === 'dark' ? 'light' : 'dark'
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
        showToolResults: updates.showToolResults ?? s.showToolResults
      }
      localStorage.setItem('heph.settings', JSON.stringify(next))
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
      session: null,
      streamingText: '',
      streamingThinking: '',
      agentStatus: 'idle'
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
      session: null,
      streamingText: '',
      streamingThinking: '',
      agentStatus: 'idle'
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
    set({ selectedSessionPath: path, selectedCwd: cwd, loadingSession: true, streamingText: '' })
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
    // Opening a new file re-enables auto-attach for it.
    set({ selectedFile: path, attachViewedFile: true })
    try {
      const fileContent = await heph.readFile(path)
      set({ fileContent })
    } catch {
      set({ fileContent: null })
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
          : fakeSession,
        agentStatus: 'running',
        streamingText: '',
        streamingThinking: ''
      }
    })
    const open = await heph.agentOpen({ harnessId, cwd, sessionPath: get().selectedSessionPath ?? undefined })
    if (!open.ok) {
      set({ agentStatus: 'idle' })
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
    await heph.agentSend({ harnessId, text: sentText })
  },

  abort: async () => {
    const harnessId = get().activeHarnessId()
    if (harnessId) await heph.agentAbort(harnessId)
    set({ agentStatus: 'idle' })
  },

  applySessionUpdate: async (path) => {
    const { selectedSessionPath, view, selectedCwd } = get()
    if (view === 'dashboard') return

    // Re-fetch project list so the sidebar shows the new session
    void get().loadProjects(view.harnessId)

    if (selectedSessionPath === null) {
      const session = await heph.loadSession(view.harnessId, path)
      if (session.header.cwd === selectedCwd) {
        set({ session, selectedSessionPath: path })
      }
      return
    }

    if (path !== selectedSessionPath) return
    const session = await heph.loadSession(view.harnessId, path)
    set({ session })
  },

  applyAgentEvent: (e) => {
    if (e.delta) {
      set((s) => ({ streamingText: s.streamingText + e.delta }))
    }
    if (e.thinkingDelta) {
      set((s) => ({ streamingThinking: s.streamingThinking + e.thinkingDelta }))
    }
    if (e.type === 'agent_end' || e.type === 'agent_exit') {
      // The watcher reloads the authoritative session; clear the stream buffers.
      set({ agentStatus: 'idle', streamingText: '', streamingThinking: '' })
    }
  }
  }
})
