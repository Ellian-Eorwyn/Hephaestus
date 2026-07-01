import { app, BrowserWindow, dialog, ipcMain, type IpcMainInvokeEvent } from 'electron'
import path from 'node:path'
import { promises as fs } from 'node:fs'
import { IPC } from '@shared/ipc'
import { HarnessRegistry } from './harness-registry'
import { SessionStore } from './session-store'
import { FileService } from './file-service'
import { checkBackend } from './backend-health'
import { AgentDriver } from './agent-driver'
import { HarnessInstaller } from './harness-installer'
import { getPreset } from '@shared/harness-presets'
import { expandHome, normalizeDir } from './harness-registry'
import { encodeCwd } from './session-parse'
import type { AgentEvent, InstallEvent } from '@shared/types'

const registry = new HarnessRegistry()
const sessions = new SessionStore()
const files = new FileService()
let mainWindow: BrowserWindow | null = null

const agent = new AgentDriver((event: AgentEvent) => {
  mainWindow?.webContents.send(IPC.evtAgentEvent, event)
})

const installer = new HarnessInstaller((event: InstallEvent) => {
  mainWindow?.webContents.send(IPC.evtInstallProgress, event)
})

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 900,
    minHeight: 600,
    backgroundColor: '#1a1614',
    titleBarStyle: 'hiddenInset',
    webPreferences: {
      preload: path.join(__dirname, '../preload/index.mjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false
    }
  })

  if (process.env.ELECTRON_RENDERER_URL) {
    mainWindow.loadURL(process.env.ELECTRON_RENDERER_URL)
  } else {
    mainWindow.loadFile(path.join(__dirname, '../renderer/index.html'))
  }

  mainWindow.on('closed', () => {
    mainWindow = null
  })
}

function watchHarnesses(): void {
  for (const h of registry.list()) {
    sessions.watch(h.id, h.agentDir, (filePath) => {
      mainWindow?.webContents.send(IPC.evtSessionUpdated, { harnessId: h.id, path: filePath })
    })
  }
}

function registerIpc(): void {
  ipcMain.handle(IPC.listHarnesses, () => registry.list())
  ipcMain.handle(IPC.addHarness, async (_e: IpcMainInvokeEvent, input) => {
    const list = await registry.add(input)
    watchHarnesses()
    return list
  })
  ipcMain.handle(IPC.removeHarness, async (_e, id: string) => {
    agent.closeHarness(id)
    return registry.remove(id)
  })

  ipcMain.handle(IPC.getHarnessPresets, () => installer.statuses(registry))
  ipcMain.handle(
    IPC.installHarness,
    async (_e, input: { presetId: string; mode: 'install' | 'update' }) => {
      const preset = getPreset(input.presetId)
      if (!preset) return { ok: false, reason: `Unknown preset ${input.presetId}` }
      const result = await installer.run(input.presetId, input.mode)
      if (!result.ok) return { ok: false, reason: result.reason }
      // Register the freshly-installed harness if it isn't already known.
      const agentDir = expandHome(preset.agentDir)
      const already = registry.list().find((h) => normalizeDir(h.agentDir) === normalizeDir(agentDir))
      if (already) {
        watchHarnesses()
        return { ok: true, harnesses: registry.list(), harnessId: already.id }
      }
      const harnesses = await registry.add({ label: preset.label, agentDir })
      watchHarnesses()
      const added = harnesses.find((h) => normalizeDir(h.agentDir) === normalizeDir(agentDir))
      return { ok: true, harnesses, harnessId: added?.id }
    }
  )

  ipcMain.handle(IPC.listProjects, async (_e, harnessId: string) => {
    const h = registry.get(harnessId)
    if (!h) return []
    return sessions.listProjects(h.agentDir)
  })

  ipcMain.handle(IPC.loadSession, async (_e, input: { harnessId: string; path: string }) => {
    const h = registry.get(input.harnessId)
    if (!h) throw new Error(`Unknown harness ${input.harnessId}`)
    return sessions.loadSession(h.agentDir, input.path)
  })

  ipcMain.handle(IPC.getModels, async (_e, harnessId: string) => {
    const h = registry.get(harnessId)
    if (!h) return null
    return sessions.getModels(h.agentDir)
  })

  ipcMain.handle(IPC.listFiles, async (_e, cwd: string) => files.listFiles(cwd))
  ipcMain.handle(IPC.readFile, async (_e, filePath: string) => files.readFile(filePath))
  ipcMain.handle(IPC.watchProject, async (_e, cwd: string) => {
    files.watch(cwd, () => {
      mainWindow?.webContents.send(IPC.evtProjectChanged, cwd)
    })
  })

  ipcMain.handle(IPC.browseFolder, async () => {
    const result = await dialog.showOpenDialog({
      properties: ['openDirectory'],
      title: 'Choose a project folder'
    })
    if (result.canceled || result.filePaths.length === 0) return null
    return result.filePaths[0]
  })

  ipcMain.handle(IPC.addProject, async (_e, input: { harnessId: string; cwd: string }) => {
    const h = registry.get(input.harnessId)
    if (!h) throw new Error(`Unknown harness ${input.harnessId}`)
    const encoded = encodeCwd(input.cwd)
    const dir = path.join(h.agentDir, 'sessions', encoded)
    await fs.mkdir(dir, { recursive: true })
    // Persist the original cwd so listProjects can recover it accurately
    // (the hyphen encoding is lossy for paths containing hyphens, spaces, @, etc.)
    const metaPath = path.join(dir, '.project.json')
    try {
      await fs.access(metaPath)
    } catch {
      await fs.writeFile(metaPath, JSON.stringify({ cwd: input.cwd }), 'utf8')
    }
    return sessions.listProjects(h.agentDir)
  })

  ipcMain.handle(IPC.removeProject, async (_e, input: { harnessId: string; encoded: string }) => {
    const h = registry.get(input.harnessId)
    if (!h) throw new Error(`Unknown harness ${input.harnessId}`)
    const dir = path.join(h.agentDir, 'sessions', input.encoded)
    await fs.rm(dir, { recursive: true, force: true })
  })

  ipcMain.handle(IPC.checkBackend, async (_e, harnessId: string) => {
    const h = registry.get(harnessId)
    if (!h) throw new Error(`Unknown harness ${harnessId}`)
    const models = await sessions.getModels(h.agentDir)
    return checkBackend(harnessId, models)
  })

  ipcMain.handle(IPC.agentOpen, async (_e, input: { harnessId: string; cwd: string; sessionPath?: string }) => {
    const h = registry.get(input.harnessId)
    if (!h) return { ok: false, reason: 'Unknown harness' }
    return agent.open(h, input.cwd, input.sessionPath)
  })
  ipcMain.handle(IPC.agentSend, async (_e, input: { runId: string; text: string }) =>
    agent.send(input.runId, input.text)
  )
  ipcMain.handle(IPC.agentAbort, async (_e, runId: string) => agent.abort(runId))
  ipcMain.handle(IPC.agentClose, async (_e, runId: string) => agent.close(runId))
  ipcMain.handle(IPC.agentListRuns, async () => agent.snapshot())
}

app.whenReady().then(async () => {
  await registry.load()
  registerIpc()
  createWindow()
  watchHarnesses()

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', async () => {
  agent.disposeAll()
  files.dispose()
  await sessions.dispose()
  if (process.platform !== 'darwin') app.quit()
})

app.on('before-quit', async () => {
  agent.disposeAll()
  files.dispose()
  await sessions.dispose()
})
