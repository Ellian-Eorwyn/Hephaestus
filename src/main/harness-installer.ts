import { spawn } from 'node:child_process'
import readline from 'node:readline'
import { promises as fs } from 'node:fs'
import type { HarnessPresetStatus, InstallEvent } from '@shared/types'
import { HARNESS_PRESETS, getPreset } from '@shared/harness-presets'
import { augmentedPath, whichInPath } from './paths'
import { expandHome, normalizeDir, type HarnessRegistry } from './harness-registry'

/**
 * Runs one-click harness installs. Each preset is installed/updated by spawning
 * its canonical shell command via a login shell (`bash -lc`) so the user's
 * profile PATH (node/git/python/npm) is available, with our augmented PATH as a
 * fallback. stdout+stderr are streamed line-by-line to the renderer as
 * InstallEvents, mirroring the AgentDriver streaming pattern.
 */
export class HarnessInstaller {
  constructor(private emit: (event: InstallEvent) => void) {}

  /** Compute install/registration status for every preset, for the modal UI. */
  async statuses(registry: HarnessRegistry): Promise<HarnessPresetStatus[]> {
    const registered = new Set(registry.list().map((h) => normalizeDir(h.agentDir)))
    const out: HarnessPresetStatus[] = []
    for (const preset of HARNESS_PRESETS) {
      const agentDir = expandHome(preset.agentDir)
      let installed = await pathExists(expandHome(preset.homeDir)) || (await pathExists(agentDir))
      // Base pi may have installed its global CLI before the agent dir exists.
      if (!installed && preset.id === 'pi') installed = (await whichInPath('pi')) !== null
      out.push({ preset, installed, registered: registered.has(normalizeDir(preset.agentDir)) })
    }
    return out
  }

  /**
   * Run an install or update for a preset. Resolves when the process exits.
   * Streams output via `emit`; the final 'done'/'error' event is also reflected
   * in the resolved value.
   */
  run(presetId: string, mode: 'install' | 'update'): Promise<{ ok: boolean; code: number | null; reason?: string }> {
    const preset = getPreset(presetId)
    if (!preset) {
      const reason = `Unknown preset ${presetId}`
      this.emit({ presetId, type: 'error', reason })
      return Promise.resolve({ ok: false, code: null, reason })
    }
    const command = mode === 'update' ? preset.updateCommand : preset.installCommand

    return new Promise((resolve) => {
      let child
      try {
        child = spawn('bash', ['-lc', command], {
          cwd: expandHome('~'),
          env: { ...process.env, PATH: augmentedPath(process.env.PATH) },
          stdio: ['ignore', 'pipe', 'pipe']
        })
      } catch (err) {
        const reason = err instanceof Error ? err.message : 'spawn failed'
        this.emit({ presetId, type: 'error', reason })
        resolve({ ok: false, code: null, reason })
        return
      }

      const outRl = readline.createInterface({ input: child.stdout })
      const errRl = readline.createInterface({ input: child.stderr })
      outRl.on('line', (line) => this.emit({ presetId, type: 'stdout', line }))
      errRl.on('line', (line) => this.emit({ presetId, type: 'stderr', line }))

      child.on('error', (err) => {
        const reason = err instanceof Error ? err.message : 'process error'
        this.emit({ presetId, type: 'error', reason })
        resolve({ ok: false, code: null, reason })
      })
      child.on('close', (code) => {
        outRl.close()
        errRl.close()
        const ok = code === 0
        this.emit({ presetId, type: ok ? 'done' : 'error', code, reason: ok ? undefined : `exited with code ${code}` })
        resolve({ ok, code })
      })
    })
  }
}

async function pathExists(p: string): Promise<boolean> {
  try {
    await fs.stat(p)
    return true
  } catch {
    return false
  }
}
