import { app, BrowserWindow, dialog, ipcMain, shell, type IpcMainInvokeEvent } from 'electron'
import path from 'node:path'
import { promises as fs } from 'node:fs'
import { IPC } from '@shared/ipc'
import { HarnessRegistry } from './harness-registry'
import { SessionStore } from './session-store'
import { FileService } from './file-service'
import { checkBackend } from './backend-health'
import { AgentDriver } from './agent-driver'
import { HarnessInstaller } from './harness-installer'
import { StackMonitor } from './stack-monitor'
import { getPreset } from '@shared/harness-presets'
import { expandHome, normalizeDir } from './harness-registry'
import { encodeCwd } from './session-parse'
import type {
  AgentBatch,
  ExtensionUIResponse,
  InstallEvent,
  StackConfigInput,
  StackStatus
} from '@shared/types'

const registry = new HarnessRegistry()
const sessions = new SessionStore()
const files = new FileService()
let mainWindow: BrowserWindow | null = null

/**
 * Append a line to the app log.
 *
 * A hang or a renderer crash leaves nothing behind otherwise — the window is dead
 * and the console with it — so the only account of what happened is whatever we
 * wrote to disk first. Fire-and-forget: logging must never be able to make things
 * worse.
 */
function log(line: string): void {
  const stamped = `${new Date().toISOString()} ${line}\n`
  console.log(stamped.trimEnd())
  try {
    const dir = app.getPath('logs')
    void fs.mkdir(dir, { recursive: true }).then(() =>
      fs.appendFile(path.join(dir, 'hephaestus.log'), stamped, 'utf8').catch(() => {})
    )
  } catch {
    // no log path available (very early startup) — the console line still went out
  }
}

/**
 * Push an event to the renderer. Guarded because teardown ordering (and a
 * reload) can leave us holding a window whose webContents is already gone,
 * while agent processes are still streaming.
 */
function send(channel: string, payload: unknown): void {
  const wc = mainWindow?.webContents
  if (!wc || wc.isDestroyed()) return
  wc.send(channel, payload)
}

const agent = new AgentDriver((batch: AgentBatch) => {
  send(IPC.evtAgentBatch, batch)
})

const installer = new HarnessInstaller((event: InstallEvent) => {
  send(IPC.evtInstallProgress, event)
})

const stack = new StackMonitor((status: StackStatus) => {
  send(IPC.evtStackStatus, status)
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

  // Nobody reads a status bar in a background window, so the stack poll backs off
  // when this one isn't in front.
  mainWindow.on('focus', () => stack.setActive(true))
  mainWindow.on('blur', () => stack.setActive(false))

  // A wedged window is the one failure mode with no other trace. Record when it
  // starts and stops so a "the app froze" report has a timestamp to sit against.
  let unresponsiveSince = 0
  mainWindow.on('unresponsive', () => {
    unresponsiveSince = Date.now()
    log('WARN window unresponsive')
  })
  mainWindow.on('responsive', () => {
    const forMs = unresponsiveSince ? Date.now() - unresponsiveSince : 0
    unresponsiveSince = 0
    log(`INFO window responsive again after ${Math.round(forMs / 1000)}s`)
  })
  mainWindow.webContents.on('render-process-gone', (_e, details) => {
    log(`ERROR renderer gone: reason=${details.reason} exitCode=${details.exitCode}`)
  })
}

function watchHarnesses(): void {
  for (const h of registry.list()) {
    sessions.watch(h.id, h.agentDir, (payload) => {
      send(IPC.evtSessionUpdated, payload)
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
  ipcMain.handle(IPC.listDir, async (_e, dir: string) => files.listDir(dir))
  ipcMain.handle(IPC.indexPaths, async (_e, cwd: string) => files.indexPaths(cwd))
  ipcMain.handle(IPC.readFile, async (_e, filePath: string) => files.readFile(filePath))
  ipcMain.handle(IPC.watchProject, async (_e, cwd: string) =>
    files.watch(cwd, (payload) => {
      send(IPC.evtProjectChanged, payload)
    })
  )

  /**
   * Open a web link from a reply in the user's browser.
   *
   * The URL comes out of model output, so the scheme allowlist is the security
   * boundary, not a formality: `openExternal` hands anything else to whatever
   * system handler claims the scheme. Only http(s) gets through, and a URL that
   * doesn't parse is dropped silently — there is nothing useful to tell the user
   * about a malformed link they didn't write.
   */
  ipcMain.handle(IPC.openExternal, async (_e, url: string) => {
    try {
      const parsed = new URL(url)
      if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return
      await shell.openExternal(parsed.href)
    } catch {
      // not a URL, or the OS declined to open it
    }
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

  /**
   * The renderer asks for this on startup and after a reload. The first poll may
   * already have fired against a window that wasn't listening yet, and the next
   * one is up to 30s away, so replay the latest status rather than leave the
   * chip blank until then.
   */
  ipcMain.handle(IPC.getStackConfig, () => {
    const last = stack.lastStatus()
    if (last) setImmediate(() => send(IPC.evtStackStatus, last))
    return stack.publicConfig()
  })
  ipcMain.handle(IPC.setStackConfig, async (_e, input: StackConfigInput) => stack.setConfig(input))
  ipcMain.handle(
    IPC.probeStack,
    async (_e, input: { baseUrl: string; token?: string | null }) =>
      stack.probe(input.baseUrl, input.token)
  )

  ipcMain.handle(IPC.agentOpen, async (_e, input: { harnessId: string; cwd: string; sessionPath?: string }) => {
    const h = registry.get(input.harnessId)
    if (!h) return { ok: false, reason: 'Unknown harness' }
    return agent.open(h, input.cwd, input.sessionPath)
  })
  ipcMain.handle(
    IPC.agentSend,
    async (_e, input: { runId: string; text: string; behavior?: 'steer' | 'followUp' }) =>
      agent.send(input.runId, input.text, input.behavior)
  )
  ipcMain.handle(
    IPC.agentRespond,
    async (_e, input: { runId: string; response: ExtensionUIResponse }) =>
      agent.respond(input.runId, input.response)
  )
  ipcMain.handle(IPC.agentAbort, async (_e, runId: string) => agent.abort(runId))
  ipcMain.handle(IPC.agentAbortRetry, async (_e, runId: string) => agent.abortRetry(runId))
  ipcMain.handle(IPC.agentClose, async (_e, runId: string) => agent.close(runId))
  ipcMain.handle(IPC.agentListRuns, async () => agent.snapshot())
}

app.whenReady().then(async () => {
  process.on('uncaughtException', (err) => {
    log(`ERROR uncaught in main: ${err?.stack ?? String(err)}`)
  })
  process.on('unhandledRejection', (reason) => {
    log(`ERROR unhandled rejection in main: ${String(reason)}`)
  })
  app.on('child-process-gone', (_e, details) => {
    log(`ERROR child process gone: type=${details.type} reason=${details.reason}`)
  })

  await registry.load()
  // Best-effort: a broken stack.json must not stop the app from starting.
  await stack.load().catch((err) => log(`WARN stack monitor config: ${String(err)}`))
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
  stack.dispose()
  await sessions.dispose()
  if (process.platform !== 'darwin') app.quit()
})

app.on('before-quit', async () => {
  agent.disposeAll()
  files.dispose()
  stack.dispose()
  await sessions.dispose()
})
