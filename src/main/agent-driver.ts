import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import readline from 'node:readline'
import type { AgentEvent, HarnessConfig } from '@shared/types'

/**
 * Drives a harness's existing runtime in headless RPC mode. We spawn
 * `node <cli> --mode rpc` with the project cwd, write JSON command lines to its
 * stdin, and parse JSONL events from its stdout — forwarding them to the
 * renderer. The harness owns tool execution, context management, and writing
 * the session .jsonl; we just relay.
 */
export class AgentDriver {
  private procs = new Map<string, AgentSession>()

  constructor(private emit: (event: AgentEvent) => void) {}

  open(harness: HarnessConfig, cwd: string, sessionPath?: string): { ok: boolean; reason?: string } {
    if (!harness.cli) {
      return { ok: false, reason: 'No RPC launcher resolved for this harness (view-only).' }
    }
    // Close any existing session for this harness first.
    this.close(harness.id)

    const args = ['--mode', 'rpc']
    if (sessionPath) args.push('--session', sessionPath)

    // The launcher is an executable bash script that sets up env and execs the
    // bundled cli.js, so spawn it directly. We prepend common node locations to
    // PATH because a GUI-launched Electron app may not inherit the user's shell
    // PATH (the launcher does `exec node …`).
    let child: ChildProcessWithoutNullStreams
    try {
      child = spawn(harness.cli, args, {
        cwd,
        env: { ...process.env, PATH: augmentedPath(process.env.PATH) },
        stdio: ['pipe', 'pipe', 'pipe']
      })
    } catch (err) {
      return { ok: false, reason: err instanceof Error ? err.message : 'spawn failed' }
    }

    const session = new AgentSession(harness.id, child, sessionPath, this.emit)
    this.procs.set(harness.id, session)
    return { ok: true }
  }

  send(harnessId: string, text: string): { ok: boolean; reason?: string } {
    const s = this.procs.get(harnessId)
    if (!s) return { ok: false, reason: 'No open agent session. Open one first.' }
    return s.send(text)
  }

  abort(harnessId: string): void {
    this.procs.get(harnessId)?.abort()
  }

  close(harnessId: string): void {
    const s = this.procs.get(harnessId)
    if (s) {
      s.dispose()
      this.procs.delete(harnessId)
    }
  }

  disposeAll(): void {
    for (const id of [...this.procs.keys()]) this.close(id)
  }
}

class AgentSession {
  private rl: readline.Interface

  constructor(
    private harnessId: string,
    private child: ChildProcessWithoutNullStreams,
    private sessionPath: string | undefined,
    private emit: (event: AgentEvent) => void
  ) {
    this.rl = readline.createInterface({ input: child.stdout })
    this.rl.on('line', (line) => this.onLine(line))
    child.stderr.on('data', (d) => {
      this.emit({ harnessId, sessionPath, type: 'stderr', delta: String(d) })
    })
    child.on('exit', (code) => {
      this.emit({ harnessId, sessionPath, type: 'agent_exit', raw: { code } })
    })
    child.on('error', (err) => {
      this.emit({ harnessId, sessionPath, type: 'error', raw: { message: err.message } })
    })
  }

  private onLine(line: string): void {
    const trimmed = line.trim()
    if (!trimmed) return
    let evt: Record<string, unknown>
    try {
      evt = JSON.parse(trimmed)
    } catch {
      return
    }
    const type = String(evt.type ?? 'unknown')
    // Extract a streaming delta from the assistantMessageEvent. We distinguish
    // visible text from thinking so the UI can stream them into different lanes.
    const { delta, thinkingDelta } = extractDeltas(evt)
    this.emit({
      harnessId: this.harnessId,
      sessionPath: this.sessionPath,
      type,
      delta,
      thinkingDelta,
      toolName: typeof evt.toolName === 'string' ? evt.toolName : undefined,
      raw: evt
    })
  }

  send(text: string): { ok: boolean; reason?: string } {
    try {
      this.child.stdin.write(JSON.stringify({ type: 'prompt', message: text }) + '\n')
      return { ok: true }
    } catch (err) {
      return { ok: false, reason: err instanceof Error ? err.message : 'write failed' }
    }
  }

  abort(): void {
    try {
      this.child.stdin.write(JSON.stringify({ type: 'abort' }) + '\n')
    } catch {
      // ignore
    }
  }

  dispose(): void {
    this.rl.close()
    try {
      this.child.kill()
    } catch {
      // ignore
    }
  }
}

/** Ensure common node install locations are on PATH for the spawned launcher. */
function augmentedPath(current: string | undefined): string {
  const extra = ['/usr/local/bin', '/opt/homebrew/bin', `${process.env.HOME}/.hermes/node/bin`]
  const parts = (current ?? '').split(':').filter(Boolean)
  for (const p of extra) if (!parts.includes(p)) parts.push(p)
  return parts.join(':')
}

/**
 * Pull streaming deltas out of a message_update event. The harness emits two
 * delta streams via assistantMessageEvent: `text_delta` (visible answer) and
 * `thinking_delta` (reasoning). We separate them so the UI can render the
 * thinking in its own collapsible lane.
 */
function extractDeltas(evt: Record<string, unknown>): { delta?: string; thinkingDelta?: string } {
  const ame = evt.assistantMessageEvent as { type?: string; delta?: string } | undefined
  if (ame && typeof ame.delta === 'string') {
    if (ame.type === 'text_delta') return { delta: ame.delta }
    if (ame.type === 'thinking_delta') return { thinkingDelta: ame.delta }
    return {}
  }
  if (typeof evt.delta === 'string') return { delta: evt.delta }
  return {}
}
