import { contextBridge, ipcRenderer, webUtils } from 'electron'
import { IPC } from '@shared/ipc'
import type { HephApi, AgentEvent, InstallEvent } from '@shared/types'

const api: HephApi = {
  // Resolve the absolute filesystem path of a dropped File. Electron 32+ removed
  // the `File.path` property, so this is the supported replacement.
  getPathForFile: (file) => webUtils.getPathForFile(file),

  listHarnesses: () => ipcRenderer.invoke(IPC.listHarnesses),
  addHarness: (input) => ipcRenderer.invoke(IPC.addHarness, input),
  removeHarness: (id) => ipcRenderer.invoke(IPC.removeHarness, id),
  getHarnessPresets: () => ipcRenderer.invoke(IPC.getHarnessPresets),
  installHarness: (input) => ipcRenderer.invoke(IPC.installHarness, input),

  listProjects: (harnessId) => ipcRenderer.invoke(IPC.listProjects, harnessId),
  loadSession: (harnessId, path) => ipcRenderer.invoke(IPC.loadSession, { harnessId, path }),
  getModels: (harnessId) => ipcRenderer.invoke(IPC.getModels, harnessId),

  listFiles: (cwd) => ipcRenderer.invoke(IPC.listFiles, cwd),
  readFile: (path) => ipcRenderer.invoke(IPC.readFile, path),
  watchProject: (cwd) => ipcRenderer.invoke(IPC.watchProject, cwd),

  browseFolder: () => ipcRenderer.invoke(IPC.browseFolder),
  addProject: (input) => ipcRenderer.invoke(IPC.addProject, input),
  removeProject: (input) => ipcRenderer.invoke(IPC.removeProject, input),

  checkBackend: (harnessId) => ipcRenderer.invoke(IPC.checkBackend, harnessId),

  agentOpen: (input) => ipcRenderer.invoke(IPC.agentOpen, input),
  agentSend: (input) => ipcRenderer.invoke(IPC.agentSend, input),
  agentAbort: (runId) => ipcRenderer.invoke(IPC.agentAbort, runId),
  agentClose: (runId) => ipcRenderer.invoke(IPC.agentClose, runId),
  agentListRuns: () => ipcRenderer.invoke(IPC.agentListRuns),

  onSessionUpdated: (cb) => {
    const listener = (_e: unknown, payload: { harnessId: string; path: string }) => cb(payload)
    ipcRenderer.on(IPC.evtSessionUpdated, listener)
    return () => ipcRenderer.removeListener(IPC.evtSessionUpdated, listener)
  },
  onAgentEvent: (cb) => {
    const listener = (_e: unknown, event: AgentEvent) => cb(event)
    ipcRenderer.on(IPC.evtAgentEvent, listener)
    return () => ipcRenderer.removeListener(IPC.evtAgentEvent, listener)
  },
  onProjectChanged: (cb) => {
    const listener = (_e: unknown, cwd: string) => cb(cwd)
    ipcRenderer.on(IPC.evtProjectChanged, listener)
    return () => ipcRenderer.removeListener(IPC.evtProjectChanged, listener)
  },
  onInstallProgress: (cb) => {
    const listener = (_e: unknown, event: InstallEvent) => cb(event)
    ipcRenderer.on(IPC.evtInstallProgress, listener)
    return () => ipcRenderer.removeListener(IPC.evtInstallProgress, listener)
  }
}

contextBridge.exposeInMainWorld('heph', api)
