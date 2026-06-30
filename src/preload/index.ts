import { contextBridge, ipcRenderer } from 'electron'
import { IPC } from '@shared/ipc'
import type { HephApi, AgentEvent } from '@shared/types'

const api: HephApi = {
  listHarnesses: () => ipcRenderer.invoke(IPC.listHarnesses),
  addHarness: (input) => ipcRenderer.invoke(IPC.addHarness, input),
  removeHarness: (id) => ipcRenderer.invoke(IPC.removeHarness, id),

  listProjects: (harnessId) => ipcRenderer.invoke(IPC.listProjects, harnessId),
  loadSession: (harnessId, path) => ipcRenderer.invoke(IPC.loadSession, { harnessId, path }),
  getModels: (harnessId) => ipcRenderer.invoke(IPC.getModels, harnessId),

  listFiles: (cwd) => ipcRenderer.invoke(IPC.listFiles, cwd),
  readFile: (path) => ipcRenderer.invoke(IPC.readFile, path),

  checkBackend: (harnessId) => ipcRenderer.invoke(IPC.checkBackend, harnessId),

  agentOpen: (input) => ipcRenderer.invoke(IPC.agentOpen, input),
  agentSend: (input) => ipcRenderer.invoke(IPC.agentSend, input),
  agentAbort: (harnessId) => ipcRenderer.invoke(IPC.agentAbort, harnessId),
  agentClose: (harnessId) => ipcRenderer.invoke(IPC.agentClose, harnessId),

  onSessionUpdated: (cb) => {
    const listener = (_e: unknown, payload: { harnessId: string; path: string }) => cb(payload)
    ipcRenderer.on(IPC.evtSessionUpdated, listener)
    return () => ipcRenderer.removeListener(IPC.evtSessionUpdated, listener)
  },
  onAgentEvent: (cb) => {
    const listener = (_e: unknown, event: AgentEvent) => cb(event)
    ipcRenderer.on(IPC.evtAgentEvent, listener)
    return () => ipcRenderer.removeListener(IPC.evtAgentEvent, listener)
  }
}

contextBridge.exposeInMainWorld('heph', api)
