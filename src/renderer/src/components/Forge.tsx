import { useEffect, useRef, useState } from 'react'
import { Send, Square, Hammer, Flame, Paperclip, X } from 'lucide-react'
import { useStore, selectCurrentRun, isWorking } from '../store/store'
import { MarkdownView } from './MarkdownView'
import { ForgeAnvil } from './ForgeAnvil'
import type { ThreadMessage } from '@shared/types'

export function Forge(): JSX.Element {
  const session = useStore((s) => s.session)
  const loading = useStore((s) => s.loadingSession)
  const run = useStore(selectCurrentRun)
  const selectedSessionPath = useStore((s) => s.selectedSessionPath)
  const selectedCwd = useStore((s) => s.selectedCwd)
  const messageSpacing = useStore((s) => s.messageSpacing)
  const bottomRef = useRef<HTMLDivElement>(null)

  const streamingText = run?.text ?? ''
  const streamingThinking = run?.thinking ?? ''
  const working = !!run && isWorking(run.status)
  // The turn has finished streaming but the authoritative session hasn't swapped
  // in yet — keep the text on screen as a settled assistant bubble (no hammer).
  const settling = !!run && run.status === 'finalizing' && !!(streamingText || streamingThinking)

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [session?.messages.length, streamingText, streamingThinking, working, settling])

  // Nothing selected at all — the cold forge.
  if (!selectedSessionPath && !selectedCwd && !run) {
    return (
      <div className="pane forge">
        <div className="empty">
          <div>
            <Flame className="glyph" />
            <h2>The forge is cold</h2>
            <p>Select a conversation from a project, or start a new one.</p>
          </div>
        </div>
      </div>
    )
  }

  // A project is open but nothing has been sent yet (no session, no live run) —
  // show the "ready" placeholder. Once a prompt is sent the optimistic session /
  // run appears and we fall through to the live thread below, even before the
  // session file has been written and adopted from disk.
  if (!selectedSessionPath && !session && !run) {
    return (
      <div className="pane forge">
        <div className="pane-header">
          <Hammer size={14} className="copper" />
          <span className="label-tech">Forge — New Session</span>
        </div>
        <div className="pane-body">
          <div className="empty">
            <div>
              <Flame className="glyph" />
              <h2>Ready to forge</h2>
              <p>Type a prompt below to start a new conversation in this project.</p>
            </div>
          </div>
        </div>
        <Composer />
      </div>
    )
  }

  return (
    <div className="pane forge">
      <div className="pane-header">
        <Hammer size={14} className="copper" />
        <span className="label-tech">{selectedSessionPath ? 'Forge — Session' : 'Forge — New Session'}</span>
      </div>
      <div className="pane-body">
        {loading && !session ? (
          <div className="empty">
            <span className="muted">Loading session…</span>
          </div>
        ) : (
          <div className={`thread spacing-${messageSpacing}`}>
            {session?.messages.map((m) => (
              <Message key={m.id} m={m} />
            ))}
            {run && working && (
              <WorkingRow
                status={run.status}
                startedAt={run.startedAt}
                currentTool={run.currentTool}
                text={streamingText}
                thinking={streamingThinking}
              />
            )}
            {settling && <SettledAssistant text={streamingText} thinking={streamingThinking} />}
            <div ref={bottomRef} />
          </div>
        )}
      </div>
      <Composer />
    </div>
  )
}

function WorkingRow({
  status,
  startedAt,
  currentTool,
  text,
  thinking
}: {
  status: string
  startedAt: number
  currentTool?: string
  text: string
  thinking: string
}): JSX.Element {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(t)
  }, [])
  const elapsed = Math.max(0, Math.floor((now - startedAt) / 1000))
  const label =
    status === 'finalizing'
      ? 'Finishing'
      : currentTool
        ? `Running ${currentTool}`
        : thinking && !text
          ? 'Thinking'
          : 'Forging'

  return (
    <div className="msg assistant working">
      <div className="avatar">
        <ForgeAnvil size={26} />
      </div>
      <div className="body">
        <div className="working-head">
          <span className="working-label">{label}…</span>
          <span className="working-elapsed">{fmtElapsed(elapsed)}</span>
        </div>
        {thinking && !text && (
          <details className="thinking" open>
            <summary>✦ thinking</summary>
            <div className="content">{thinking}</div>
          </details>
        )}
        {text && <MarkdownView source={text} />}
        {text && <span className="muted">▍</span>}
      </div>
    </div>
  )
}

function fmtElapsed(s: number): string {
  const m = Math.floor(s / 60)
  const r = s % 60
  return m ? `${m}m ${r}s` : `${r}s`
}

/**
 * The just-finished streamed reply, shown as a calm assistant bubble while the
 * authoritative session reload swaps in. Identical layout to a persisted
 * assistant message so the handoff is visually seamless — and it guarantees the
 * text never blinks out between "done streaming" and "reloaded".
 */
function SettledAssistant({ text, thinking }: { text: string; thinking: string }): JSX.Element {
  const showThinking = useStore((s) => s.showThinking)
  return (
    <div className="msg assistant">
      <div className="avatar">
        <Hammer size={15} />
      </div>
      <div className="body">
        {thinking && showThinking && !text && (
          <details className="thinking">
            <summary>✦ thinking</summary>
            <div className="content">{thinking}</div>
          </details>
        )}
        {text && <MarkdownView source={text} />}
      </div>
    </div>
  )
}

function Message({ m }: { m: ThreadMessage }): JSX.Element | null {
  const showThinking = useStore((s) => s.showThinking)
  const showTools = useStore((s) => s.showTools)
  const showToolResults = useStore((s) => s.showToolResults)

  if (m.role === 'user') {
    return (
      <div className="msg user">
        <div className="bubble">
          {m.text}
          {m.attachedFile && (
            <div className="attach-chip" title={m.attachedFile}>
              <Paperclip size={11} />
              {basename(m.attachedFile)}
            </div>
          )}
        </div>
      </div>
    )
  }
  if (m.role === 'system') {
    return (
      <div className="msg assistant">
        <div className="body copper" style={{ fontFamily: 'var(--font-mono)', fontSize: 13 }}>
          {m.text}
        </div>
      </div>
    )
  }
  if (m.role === 'toolResult') {
    if (!showToolResults) return null
    return (
      <details className={`toolblock ${m.toolResult?.isError ? 'err' : ''}`}>
        <summary>
          ▸ result — {m.toolResult?.toolName ?? 'tool'} {m.toolResult?.isError ? '(error)' : ''}
        </summary>
        <div className="content">
          <div className="toolout">{truncate(m.toolResult?.text ?? '', 6000)}</div>
        </div>
      </details>
    )
  }
  // assistant
  const showThinkingBlock = !!m.thinking && showThinking
  const showToolBlocks = !!m.toolCalls && m.toolCalls.length > 0 && showTools
  // Nothing visible to render (e.g. a thinking/tool-only turn with those panes
  // toggled off) — skip the row entirely instead of leaving a lone avatar glyph.
  if (!m.text && !showThinkingBlock && !showToolBlocks) return null
  return (
    <div className="msg assistant">
      <div className="avatar">
        <Hammer size={15} />
      </div>
      <div className="body">
        {showThinkingBlock && (
          <details className="thinking">
            <summary>✦ thinking</summary>
            <div className="content">{m.thinking}</div>
          </details>
        )}
        {m.text && <MarkdownView source={m.text} />}
        {showToolBlocks &&
          m.toolCalls!.map((tc) => (
            <details className="toolblock" key={tc.id}>
              <summary>⚙ {tc.name}</summary>
              <div className="content">
                <div className="toolargs">{formatArgs(tc.arguments)}</div>
              </div>
            </details>
          ))}
        <MsgStats m={m} />
      </div>
    </div>
  )
}

/** Compact per-response stats line: output tokens, throughput, model. */
function MsgStats({ m }: { m: ThreadMessage }): JSX.Element | null {
  const parts: string[] = []
  if (m.outputTokens) parts.push(`${fmtTok(m.outputTokens)} out`)
  if (m.tps) parts.push(`${m.tps >= 100 ? Math.round(m.tps) : m.tps.toFixed(1)} tok/s`)
  if (m.usage?.cacheRead) parts.push(`${fmtTok(m.usage.cacheRead)} cached`)
  if (m.model) parts.push(m.model)
  if (parts.length === 0) return null
  return <div className="msg-stats">{parts.join('  ·  ')}</div>
}

function fmtTok(n: number): string {
  return n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n)
}

const COMPOSER_MAX_H = 160

function Composer(): JSX.Element {
  const [text, setText] = useState('')
  const sendPrompt = useStore((s) => s.sendPrompt)
  const abort = useStore((s) => s.abort)
  const run = useStore(selectCurrentRun)
  const harnesses = useStore((s) => s.harnesses)
  const view = useStore((s) => s.view)
  const selectedCwd = useStore((s) => s.selectedCwd)
  const selectedFile = useStore((s) => s.selectedFile)
  const attachViewedFile = useStore((s) => s.attachViewedFile)
  const setAttachViewedFile = useStore((s) => s.setAttachViewedFile)
  const taRef = useRef<HTMLTextAreaElement>(null)

  const harnessId = view === 'dashboard' ? null : view.harnessId
  const harness = harnesses.find((h) => h.id === harnessId)
  const canSend = !!harness?.cli && !!selectedCwd
  const showAttach = canSend && !!selectedFile

  // Grow the textarea to fit its content (up to a cap, then scroll) so typed
  // lines are never clipped at the top of the box.
  useEffect(() => {
    const el = taRef.current
    if (!el) return
    el.style.height = 'auto'
    el.style.height = `${Math.min(el.scrollHeight, COMPOSER_MAX_H)}px`
  }, [text])

  const submit = () => {
    const t = text.trim()
    if (!t || !canSend) return
    void sendPrompt(t)
    setText('')
  }

  const running = !!run && isWorking(run.status)

  return (
    <div className="composer">
      {showAttach && (
        <div className={`attach-bar ${attachViewedFile ? 'on' : 'off'}`}>
          <Paperclip size={12} />
          {attachViewedFile ? (
            <>
              <span>
                Referencing <span className="copper">{basename(selectedFile as string)}</span> — the agent
                will know you mean this file
              </span>
              <button className="attach-toggle" title="Don't attach" onClick={() => setAttachViewedFile(false)}>
                <X size={12} />
              </button>
            </>
          ) : (
            <>
              <span className="muted">{basename(selectedFile as string)} not attached</span>
              <button className="attach-toggle" onClick={() => setAttachViewedFile(true)}>
                attach
              </button>
            </>
          )}
        </div>
      )}
      <div className="box">
        <textarea
          ref={taRef}
          rows={1}
          placeholder={canSend ? 'Command the forge…' : 'Viewing only — no RPC launcher for this harness'}
          value={text}
          disabled={!canSend}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault()
              submit()
            }
          }}
        />
        {running ? (
          <button className="send-btn" title="Stop" onClick={() => void abort()}>
            <Square size={15} />
          </button>
        ) : (
          <button className="send-btn" title="Send" disabled={!canSend || !text.trim()} onClick={submit}>
            <Send size={16} />
          </button>
        )}
      </div>
      {!canSend && selectedCwd && (
        <div className="note">
          This harness has no resolved CLI launcher, so prompts are disabled. Browsing and tracking still work.
        </div>
      )}
    </div>
  )
}

function formatArgs(args: unknown): string {
  if (args && typeof args === 'object' && 'command' in args) {
    return String((args as { command: unknown }).command)
  }
  try {
    return JSON.stringify(args, null, 2)
  } catch {
    return String(args)
  }
}

function truncate(s: string, n: number): string {
  return s.length > n ? s.slice(0, n) + `\n… (${s.length - n} more chars)` : s
}

function basename(p: string): string {
  return p.split('/').pop() ?? p
}
