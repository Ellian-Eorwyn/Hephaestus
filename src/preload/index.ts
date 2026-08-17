import { contextBridge, ipcRenderer, webUtils } from 'electron'
import os from 'node:os'
import { IPC } from '@shared/ipc'
import type {
  HephApi,
  AgentBatch,
  InstallEvent,
  ProjectChangePayload,
  SessionUpdatePayload,
  StackStatus
} from '@shared/types'

const api: HephApi = {
  // Resolve the absolute filesystem path of a dropped File. Electron 32+ removed
  // the `File.path` property, so this is the supported replacement.
  getPathForFile: (file) => webUtils.getPathForFile(file),

  // A plain value rather than a round-trip: the renderer needs it to expand `~` in
  // file references the agent writes, on every rendered message.
  homeDir: os.homedir(),

  // What's actually running, for the Settings footer. `app.getVersion()` lives in
  // main, so the app version is baked in by the preload build instead; the rest
  // come straight off this process.
  versions: {
    app: __APP_VERSION__,
    electron: process.versions.electron,
    chrome: process.versions.chrome
  },

  listHarnesses: () => ipcRenderer.invoke(IPC.listHarnesses),
  addHarness: (input) => ipcRenderer.invoke(IPC.addHarness, input),
  removeHarness: (id) => ipcRenderer.invoke(IPC.removeHarness, id),
  getHarnessPresets: () => ipcRenderer.invoke(IPC.getHarnessPresets),
  installHarness: (input) => ipcRenderer.invoke(IPC.installHarness, input),

  listProjects: (harnessId) => ipcRenderer.invoke(IPC.listProjects, harnessId),
  loadSession: (harnessId, path) => ipcRenderer.invoke(IPC.loadSession, { harnessId, path }),
  getModels: (harnessId) => ipcRenderer.invoke(IPC.getModels, harnessId),

  listFiles: (cwd) => ipcRenderer.invoke(IPC.listFiles, cwd),
  listDir: (path) => ipcRenderer.invoke(IPC.listDir, path),
  indexPaths: (cwd) => ipcRenderer.invoke(IPC.indexPaths, cwd),
  readFile: (path) => ipcRenderer.invoke(IPC.readFile, path),
  watchProject: (cwd) => ipcRenderer.invoke(IPC.watchProject, cwd),

  openExternal: (url) => ipcRenderer.invoke(IPC.openExternal, url),

  browseFolder: () => ipcRenderer.invoke(IPC.browseFolder),
  addProject: (input) => ipcRenderer.invoke(IPC.addProject, input),
  removeProject: (input) => ipcRenderer.invoke(IPC.removeProject, input),

  checkBackend: (harnessId) => ipcRenderer.invoke(IPC.checkBackend, harnessId),

  getStackConfig: () => ipcRenderer.invoke(IPC.getStackConfig),
  setStackConfig: (input) => ipcRenderer.invoke(IPC.setStackConfig, input),
  probeStack: (input) => ipcRenderer.invoke(IPC.probeStack, input),

  agentOpen: (input) => ipcRenderer.invoke(IPC.agentOpen, input),
  agentSend: (input) => ipcRenderer.invoke(IPC.agentSend, input),
  agentRespond: (input) => ipcRenderer.invoke(IPC.agentRespond, input),
  agentAbort: (runId) => ipcRenderer.invoke(IPC.agentAbort, runId),
  agentAbortRetry: (runId) => ipcRenderer.invoke(IPC.agentAbortRetry, runId),
  agentClose: (runId) => ipcRenderer.invoke(IPC.agentClose, runId),
  agentListRuns: () => ipcRenderer.invoke(IPC.agentListRuns),

  agentSetModel: (input) => ipcRenderer.invoke(IPC.agentSetModel, input),
  agentCycleModel: (input) => ipcRenderer.invoke(IPC.agentCycleModel, input),
  agentGetAvailableModels: (runId) => ipcRenderer.invoke(IPC.agentGetAvailableModels, runId),
  agentSetThinkingLevel: (input) => ipcRenderer.invoke(IPC.agentSetThinkingLevel, input),
  agentCycleThinkingLevel: (input) => ipcRenderer.invoke(IPC.agentCycleThinkingLevel, input),
  agentGetState: (runId) => ipcRenderer.invoke(IPC.agentGetState, runId),
  agentGetCommands: (runId) => ipcRenderer.invoke(IPC.agentGetCommands, runId),
  agentCompact: (input) => ipcRenderer.invoke(IPC.agentCompact, input),
  agentSetSessionName: (input) => ipcRenderer.invoke(IPC.agentSetSessionName, input),
  agentClone: (input) => ipcRenderer.invoke(IPC.agentClone, input),
  agentGetForkMessages: (runId) => ipcRenderer.invoke(IPC.agentGetForkMessages, runId),
  agentFork: (input) => ipcRenderer.invoke(IPC.agentFork, input),

  onSessionUpdated: (cb) => {
    const listener = (_e: unknown, payload: SessionUpdatePayload) => cb(payload)
    ipcRenderer.on(IPC.evtSessionUpdated, listener)
    return () => ipcRenderer.removeListener(IPC.evtSessionUpdated, listener)
  },
  onAgentBatch: (cb) => {
    const listener = (_e: unknown, batch: AgentBatch) => cb(batch)
    ipcRenderer.on(IPC.evtAgentBatch, listener)
    return () => ipcRenderer.removeListener(IPC.evtAgentBatch, listener)
  },
  onProjectChanged: (cb) => {
    const listener = (_e: unknown, payload: ProjectChangePayload) => cb(payload)
    ipcRenderer.on(IPC.evtProjectChanged, listener)
    return () => ipcRenderer.removeListener(IPC.evtProjectChanged, listener)
  },
  onInstallProgress: (cb) => {
    const listener = (_e: unknown, event: InstallEvent) => cb(event)
    ipcRenderer.on(IPC.evtInstallProgress, listener)
    return () => ipcRenderer.removeListener(IPC.evtInstallProgress, listener)
  },
  onStackStatus: (cb) => {
    const listener = (_e: unknown, status: StackStatus) => cb(status)
    ipcRenderer.on(IPC.evtStackStatus, listener)
    return () => ipcRenderer.removeListener(IPC.evtStackStatus, listener)
  }
}

contextBridge.exposeInMainWorld('heph', api)
