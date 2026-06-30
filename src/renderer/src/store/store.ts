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

const heph = window.heph

type View = 'dashboard' | { harnessId: string }

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

  // status
  backend: Record<string, BackendHealth>

  // actions
  init: () => Promise<void>
  setView: (v: View) => void
  toggleTheme: () => void
  toggleZen: () => void
  setAddModal: (open: boolean) => void
  addHarness: (input: { label: string; agentDir: string }) => Promise<void>

  activeHarnessId: () => string | null
  loadProjects: (harnessId: string) => Promise<void>
  toggleProject: (p: ProjectSummary) => void
  selectSession: (harnessId: string, path: string, cwd: string) => Promise<void>
  selectFile: (path: string) => Promise<void>
  refreshBackend: (harnessId: string) => Promise<void>

  sendPrompt: (text: string) => Promise<void>
  abort: () => Promise<void>
  applySessionUpdate: (path: string) => Promise<void>
  applyAgentEvent: (e: AgentEvent) => void
}

export const useStore = create<State>((set, get) => ({
  harnesses: [],
  view: 'dashboard',
  theme: (localStorage.getItem('heph.theme') as 'dark' | 'light') ?? 'dark',
  zen: false,
  addModalOpen: false,

  projects: [],
  expanded: {},
  selectedCwd: null,

  selectedSessionPath: null,
  session: null,
  loadingSession: false,

  agentStatus: 'idle',
  streamingText: '',
  streamingThinking: '',

  fileTree: [],
  selectedFile: null,
  fileContent: null,

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
    set({ view: v })
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

  selectSession: async (harnessId, path, cwd) => {
    set({ selectedSessionPath: path, selectedCwd: cwd, loadingSession: true, streamingText: '' })
    const session = await heph.loadSession(harnessId, path)
    set({ session, loadingSession: false })
    // Load the file tree for this project's cwd.
    try {
      const fileTree = await heph.listFiles(cwd)
      set({ fileTree, selectedFile: null, fileContent: null })
    } catch {
      set({ fileTree: [], selectedFile: null, fileContent: null })
    }
  },

  selectFile: async (path) => {
    set({ selectedFile: path })
    try {
      const fileContent = await heph.readFile(path)
      set({ fileContent })
    } catch {
      set({ fileContent: null })
    }
  },

  refreshBackend: async (harnessId) => {
    try {
      const health = await heph.checkBackend(harnessId)
      set((s) => ({ backend: { ...s.backend, [harnessId]: health } }))
    } catch {
      // ignore
    }
  },

  sendPrompt: async (text) => {
    const harnessId = get().activeHarnessId()
    const cwd = get().selectedCwd
    if (!harnessId || !cwd) return
    // Optimistically append the user message.
    const userMsg: ThreadMessage = { id: `local-${Date.now()}`, role: 'user', text }
    set((s) => ({
      session: s.session
        ? { ...s.session, messages: [...s.session.messages, userMsg] }
        : s.session,
      agentStatus: 'running',
      streamingText: '',
      streamingThinking: ''
    }))
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
    await heph.agentSend({ harnessId, text })
  },

  abort: async () => {
    const harnessId = get().activeHarnessId()
    if (harnessId) await heph.agentAbort(harnessId)
    set({ agentStatus: 'idle' })
  },

  applySessionUpdate: async (path) => {
    const { selectedSessionPath, view } = get()
    if (path !== selectedSessionPath) return
    if (view === 'dashboard') return
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
}))
