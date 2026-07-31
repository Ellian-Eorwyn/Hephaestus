import { memo, useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { useShallow } from 'zustand/react/shallow'
import {
  Send,
  Square,
  Flame,
  Hammer,
  Paperclip,
  X,
  Info,
  AlertTriangle,
  XCircle,
  ArrowDown,
  CornerDownRight
} from 'lucide-react'
import {
  useStore,
  selectCurrentRunId,
  isWorking,
  promptsForRun,
  type PendingPrompt,
  type Notice
} from '../store/store'
import { ICON, AVATAR_GLYPH } from '../lib/icons'
import { resolveExplicit } from '../lib/filelinks'
import { FileLink, useLinkContext } from './FileLink'
import { MarkdownView } from './MarkdownView'
import { StreamMarkdown } from './StreamMarkdown'
import { ForgeAnvil } from './ForgeAnvil'
import type { RunStatus, ThreadMessage } from '@shared/types'

/** Which optional panes to render on a message. Passed down so each row doesn't subscribe. */
export interface DisplayToggles {
  thinking: boolean
  tools: boolean
  toolResults: boolean
}

/** How close to the bottom still counts as "following along". */
const PIN_THRESHOLD = 60

export function Forge(): JSX.Element {
  const session = useStore((s) => s.session)
  const loading = useStore((s) => s.loadingSession)
  const selectedSessionPath = useStore((s) => s.selectedSessionPath)
  const selectedCwd = useStore((s) => s.selectedCwd)
  const messageSpacing = useStore((s) => s.messageSpacing)
  const notices = useStore((s) => s.notices)

  // Subscribe to the run by id + the few fields we render, never to the stream
  // text — that belongs to <LiveRow>, the only thing that should repaint per frame.
  const runId = useStore(selectCurrentRunId)
  const run = useStore(
    useShallow((s) => {
      const r = runId ? s.runs[runId] : undefined
      return r
        ? {
            status: r.status,
            startedAt: r.startedAt,
            currentTool: r.currentTool,
            phase: r.phase,
            retry: r.retry,
            uiStatus: r.uiStatus,
            unresponsive: r.unresponsive
          }
        : undefined
    })
  )
  const hasStream = useStore((s) => (runId ? !!s.streams[runId] : false))
  const show: DisplayToggles = useStore(
    useShallow((s) => ({
      thinking: s.showThinking,
      tools: s.showTools,
      toolResults: s.showToolResults
    }))
  )
  const prompts = useStore(useShallow((s) => promptsForRun(s.pendingPrompts, runId ?? undefined)))

  const bodyRef = useRef<HTMLDivElement>(null)
  const pinnedRef = useRef(true)
  const [pinned, setPinned] = useState(true)

  const onScroll = useCallback(() => {
    const el = bodyRef.current
    if (!el) return
    const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < PIN_THRESHOLD
    // Only re-render when the pinned-ness actually flips, not on every scroll tick.
    if (atBottom !== pinnedRef.current) {
      pinnedRef.current = atBottom
      setPinned(atBottom)
    }
  }, [])

  /**
   * Keep the newest content in view while the user is following along, and leave
   * the scroll position completely alone once they've scrolled up to read back.
   * An instant `scrollTop` assignment inside rAF (rather than a smooth
   * scrollIntoView) is what stops the view from fighting itself when new text
   * arrives many times a second.
   */
  const stickToBottom = useCallback(() => {
    if (!pinnedRef.current) return
    requestAnimationFrame(() => {
      const el = bodyRef.current
      if (el && pinnedRef.current) el.scrollTop = el.scrollHeight
    })
  }, [])

  useLayoutEffect(() => {
    stickToBottom()
  }, [session?.messages.length, prompts.length, notices.length, run?.status, stickToBottom])

  // Switching conversations should start pinned to the newest message again.
  useEffect(() => {
    pinnedRef.current = true
    setPinned(true)
  }, [selectedSessionPath, selectedCwd])

  const jumpToBottom = (): void => {
    pinnedRef.current = true
    setPinned(true)
    const el = bodyRef.current
    if (el) el.scrollTop = el.scrollHeight
  }

  // Nothing selected at all — the cold forge.
  if (!selectedSessionPath && !selectedCwd && !run) {
    return (
      <div className="pane forge">
        <div className="empty">
          <div>
            <Flame className="glyph" size={ICON.hero} />
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
          <Hammer size={ICON.sm} className="copper" />
          <span className="label-tech">Forge — New Session</span>
        </div>
        <div className="pane-body">
          <div className="empty">
            <div>
              <Flame className="glyph" size={ICON.hero} />
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
        <Hammer size={ICON.sm} className="copper" />
        <span className="label-tech">{selectedSessionPath ? 'Forge — Session' : 'Forge — New Session'}</span>
      </div>
      <div className="pane-body" ref={bodyRef} onScroll={onScroll}>
        {loading && !session ? (
          <div className="empty">
            <span className="muted">Loading session…</span>
          </div>
        ) : (
          <div className={`thread spacing-${messageSpacing}`}>
            {session?.messages.map((m) => (
              <Message key={m.id} m={m} show={show} />
            ))}
            {runId && run && hasStream && (
              <LiveRow
                runId={runId}
                status={run.status}
                startedAt={run.startedAt}
                currentTool={run.currentTool}
                waiting={prompts.length > 0}
                phase={run.phase}
                uiStatus={run.uiStatus?.status}
                showThinking={show.thinking}
                onAdvance={stickToBottom}
              />
            )}
            {runId && run?.retry && <RetryCard retry={run.retry} />}
            {runId && run?.unresponsive && <UnresponsiveCard runId={runId} />}
            {prompts.map((p) => (
              <InteractivePrompt key={p.id} prompt={p} />
            ))}
            {notices.map((n) => (
              <NoticeRow key={n.id} notice={n} />
            ))}
          </div>
        )}
        {!pinned && (
          <button className="jump-bottom" title="Jump to latest" onClick={jumpToBottom}>
            <ArrowDown size={ICON.sm} />
            Latest
          </button>
        )}
      </div>
      <Composer />
    </div>
  )
}

/**
 * The live turn. This is the only component subscribed to the stream buffers, so
 * it is the only thing React repaints as text arrives — the settled thread above
 * it, the sidebar, and the composer all stay untouched.
 */
const LiveRow = memo(function LiveRow({
  runId,
  status,
  startedAt,
  currentTool,
  waiting,
  phase,
  uiStatus,
  showThinking,
  onAdvance
}: {
  runId: string
  status: RunStatus
  startedAt: number
  currentTool?: string
  waiting: boolean
  phase?: 'compacting' | 'retrying' | null
  uiStatus?: string
  showThinking: boolean
  onAdvance: () => void
}): JSX.Element | null {
  const stream = useStore((s) => s.streams[runId])
  const text = stream?.text ?? ''
  const thinking = stream?.thinking ?? ''

  // Runs after every commit of this subtree, i.e. once per flush.
  useLayoutEffect(() => {
    onAdvance()
  })

  if (isWorking(status)) {
    return (
      <WorkingRow
        status={status}
        startedAt={startedAt}
        currentTool={currentTool}
        text={text}
        thinking={thinking}
        waiting={waiting}
        phase={phase}
        uiStatus={uiStatus}
      />
    )
  }
  // The turn has finished streaming but the authoritative session hasn't swapped
  // in yet — keep the text on screen as a settled assistant bubble (no hammer).
  if (status === 'finalizing' && (text || thinking)) {
    return <SettledAssistant text={text} thinking={thinking} showThinking={showThinking} />
  }
  return null
})

function WorkingRow({
  status,
  startedAt,
  currentTool,
  text,
  thinking,
  waiting,
  phase,
  uiStatus
}: {
  status: string
  startedAt: number
  currentTool?: string
  text: string
  thinking: string
  waiting?: boolean
  phase?: 'compacting' | 'retrying' | null
  uiStatus?: string
}): JSX.Element {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(t)
  }, [])
  const elapsed = Math.max(0, Math.floor((now - startedAt) / 1000))
  // Compaction and retries produce no output, so without naming them the UI just
  // looks stalled.
  const label = waiting
    ? 'Waiting for you'
    : phase === 'compacting'
      ? 'Compacting context'
      : phase === 'retrying'
        ? 'Retrying'
        : status === 'finalizing'
          ? 'Finishing'
          : currentTool
            ? `Running ${currentTool}`
            : thinking && !text
              ? 'Thinking'
              : 'Forging'

  return (
    <div className="msg assistant working">
      <div className="avatar">
        <ForgeAnvil size={AVATAR_GLYPH} />
      </div>
      <div className="body">
        <div className="working-head">
          <span className="working-label">{label}…</span>
          <span className="working-elapsed">{fmtElapsed(elapsed)}</span>
        </div>
        {/* Status an extension pushed via ctx.ui.setStatus — previously dropped. */}
        {uiStatus && <div className="working-substatus">{uiStatus}</div>}
        {thinking && !text && (
          <details className="thinking" open>
            <summary>✦ thinking</summary>
            <div className="content">{thinking}</div>
          </details>
        )}
        {text && <StreamMarkdown source={text} />}
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
function SettledAssistant({
  text,
  thinking,
  showThinking
}: {
  text: string
  thinking: string
  showThinking: boolean
}): JSX.Element {
  return (
    <div className="msg assistant">
      <div className="avatar">
        <Hammer size={AVATAR_GLYPH} />
      </div>
      <div className="body">
        {thinking && showThinking && !text && (
          <details className="thinking">
            <summary>✦ thinking</summary>
            <div className="content">{thinking}</div>
          </details>
        )}
        {/* Same block-memoized renderer as while streaming, so the handoff to the
            settled bubble doesn't re-parse the whole reply from scratch. */}
        {text && <StreamMarkdown source={text} />}
      </div>
    </div>
  )
}

/**
 * A rich, inline card for an interactive prompt the harness raised mid-turn
 * (RPC extension_ui_request). Answering writes an extension_ui_response back on
 * the same channel, resuming the paused turn. Every variant offers a Cancel that
 * sends `{cancelled:true}` so the turn can always be released.
 */
function InteractivePrompt({ prompt }: { prompt: PendingPrompt }): JSX.Element {
  const answer = useStore((s) => s.answerPrompt)
  const req = prompt.request
  const cancel = (): void => void answer(prompt.id, { cancelled: true })

  // input/editor local draft (editor seeds from prefill). Hooks run for every
  // variant; only input/editor read the value.
  const [draft, setDraft] = useState(() =>
    req.method === 'editor' ? (req.prefill ?? '') : ''
  )
  const taRef = useRef<HTMLTextAreaElement>(null)
  useEffect(() => {
    const el = taRef.current
    if (!el) return
    el.style.height = 'auto'
    el.style.height = `${Math.min(el.scrollHeight, 260)}px`
  }, [draft])

  return (
    <div className="msg assistant">
      <div className="avatar">
        <Hammer size={AVATAR_GLYPH} />
      </div>
      <div className="body">
        <div className={`prompt-card ${req.method}`}>
          <div className="prompt-title">{req.title}</div>

          {req.method === 'select' && (
            <div className="prompt-options">
              {req.options.map((opt) => (
                <button
                  key={opt}
                  className="btn"
                  onClick={() => void answer(prompt.id, { value: opt })}
                >
                  {opt}
                </button>
              ))}
            </div>
          )}

          {req.method === 'confirm' && req.message && (
            <div className="prompt-message">{req.message}</div>
          )}

          {req.method === 'input' && (
            <div className="field">
              <input
                autoFocus
                placeholder={req.placeholder}
                value={draft}
                onChange={(e) => setDraft(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') {
                    e.preventDefault()
                    void answer(prompt.id, { value: draft })
                  }
                }}
              />
            </div>
          )}

          {req.method === 'editor' && (
            <textarea
              ref={taRef}
              className="prompt-editor"
              autoFocus
              rows={3}
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
            />
          )}

          <div className="prompt-actions">
            {req.method === 'confirm' ? (
              <>
                <button
                  className="btn primary"
                  onClick={() => void answer(prompt.id, { confirmed: true })}
                >
                  Confirm
                </button>
                <button
                  className="btn"
                  onClick={() => void answer(prompt.id, { confirmed: false })}
                >
                  Decline
                </button>
              </>
            ) : req.method === 'input' || req.method === 'editor' ? (
              <>
                <button
                  className="btn primary"
                  onClick={() => void answer(prompt.id, { value: draft })}
                >
                  Submit
                </button>
                <button className="btn ghost" onClick={cancel}>
                  Cancel
                </button>
              </>
            ) : (
              <button className="btn ghost" onClick={cancel}>
                Cancel
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  )
}

/**
 * A provider call failed and the harness is waiting out a backoff before trying
 * again. Without this the UI just sits there looking hung.
 */
function RetryCard({
  retry
}: {
  retry: NonNullable<import('../store/store').RunMeta['retry']>
}): JSX.Element {
  const abortRetry = useStore((s) => s.abortRetry)
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 250)
    return () => clearInterval(t)
  }, [])
  const remaining = Math.max(0, retry.startedAt + retry.delayMs - now)

  return (
    <div className="msg assistant">
      <div className="avatar">
        <Hammer size={AVATAR_GLYPH} />
      </div>
      <div className="body">
        <div className="retry-card">
          <div className="retry-head">
            <AlertTriangle size={ICON.sm} />
            <span>
              Attempt {retry.attempt} of {retry.maxAttempts}
              {remaining > 0 ? ` — retrying in ${Math.ceil(remaining / 1000)}s` : ' — retrying now'}
            </span>
            <button className="btn ghost" onClick={() => void abortRetry()}>
              Cancel retry
            </button>
          </div>
          {retry.errorMessage && <div className="retry-reason">{retry.errorMessage}</div>}
        </div>
      </div>
    </div>
  )
}

/** The harness stopped answering liveness pings mid-turn. */
function UnresponsiveCard({ runId }: { runId: string }): JSX.Element {
  const restartRun = useStore((s) => s.restartRun)
  return (
    <div className="msg assistant">
      <div className="avatar">
        <Hammer size={AVATAR_GLYPH} />
      </div>
      <div className="body">
        <div className="retry-card">
          <div className="retry-head">
            <AlertTriangle size={ICON.sm} />
            <span>The harness stopped responding.</span>
            <button className="btn ghost" onClick={() => void restartRun(runId)}>
              Restart
            </button>
          </div>
          <div className="retry-reason">
            It may still be working on something slow. Restarting ends this run and
            starts a fresh process.
          </div>
        </div>
      </div>
    </div>
  )
}

/** A transient, auto-dismissing notice from the harness (`notify`). */
function NoticeRow({ notice }: { notice: Notice }): JSX.Element {
  const dismiss = useStore((s) => s.dismissNotice)
  useEffect(() => {
    const t = setTimeout(() => dismiss(notice.id), 8000)
    return () => clearTimeout(t)
  }, [notice.id, dismiss])
  const Icon = notice.kind === 'error' ? XCircle : notice.kind === 'warning' ? AlertTriangle : Info
  return (
    <div className={`notice ${notice.kind}`}>
      <Icon size={ICON.sm} />
      <span className="notice-msg">{notice.message}</span>
      <button className="notice-close" title="Dismiss" onClick={() => dismiss(notice.id)}>
        <X size={ICON.xs} />
      </button>
    </div>
  )
}

/**
 * A settled message from the session file. Memoized on `m` identity and the
 * shared toggles object: a streaming turn never changes either, so a long thread
 * costs nothing to keep on screen while new text arrives.
 */
const Message = memo(function Message({
  m,
  show
}: {
  m: ThreadMessage
  show: DisplayToggles
}): JSX.Element | null {
  const { thinking: showThinking, tools: showTools, toolResults: showToolResults } = show

  if (m.role === 'user') {
    return (
      <div className="msg user">
        <div className="bubble">
          {m.text}
          {m.attachedFile && (
            <div className="attach-chip" title={m.attachedFile}>
              <Paperclip size={ICON.xs} />
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
        <Hammer size={AVATAR_GLYPH} />
      </div>
      <div className="body">
        {showThinkingBlock && (
          <details className="thinking">
            <summary>✦ thinking</summary>
            <div className="content">{m.thinking}</div>
          </details>
        )}
        {m.text && <MarkdownView source={m.text} />}
        {showToolBlocks && m.toolCalls!.map((tc) => <ToolCallBlock key={tc.id} call={tc} />)}
        <MsgStats m={m} />
      </div>
    </div>
  )
})

/**
 * One tool call the agent made. When its arguments name a file, that path is shown
 * as a link at the top of the block — the most direct "the agent touched this file,
 * show me" affordance there is.
 */
function ToolCallBlock({
  call
}: {
  call: NonNullable<ThreadMessage['toolCalls']>[number]
}): JSX.Element {
  const linkCtx = useLinkContext()
  const raw = (call.arguments as { path?: unknown } | null)?.path
  const ref = typeof raw === 'string' ? resolveExplicit(raw, linkCtx) : null

  return (
    <details className="toolblock">
      <summary>⚙ {call.name}</summary>
      <div className="content">
        {ref && (
          <div className="toolpath">
            <FileLink path={ref.path} line={ref.line} variant="chip" />
          </div>
        )}
        <div className="toolargs">{formatArgs(call.arguments)}</div>
      </div>
    </details>
  )
}

/** Compact per-response stats line: output tokens, throughput, model. */
function MsgStats({ m }: { m: ThreadMessage }): JSX.Element | null {
  const parts: string[] = []
  if (m.outputTokens) parts.push(`${fmtTok(m.outputTokens)} out`)
  if (m.tps) {
    // A leading `~` marks a rate derived from record timestamps or measured by us,
    // as opposed to one the inference backend reported.
    const rate = m.tps >= 100 ? Math.round(m.tps) : m.tps.toFixed(1)
    parts.push(`${m.tpsApprox === false ? '' : '~'}${rate} tok/s`)
  }
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
  // A boolean, not the run object: typing in here must not re-render per frame of
  // streamed output, and this only flips at the edges of a turn.
  const running = useStore((s) => {
    const id = selectCurrentRunId(s)
    return !!id && isWorking(s.runs[id]?.status ?? 'idle')
  })
  const harnesses = useStore((s) => s.harnesses)
  const view = useStore((s) => s.view)
  const selectedCwd = useStore((s) => s.selectedCwd)
  const selectedFile = useStore((s) => s.selectedFile)
  const attachViewedFile = useStore((s) => s.attachViewedFile)
  const setAttachViewedFile = useStore((s) => s.setAttachViewedFile)
  const draftRestore = useStore((s) => s.draftRestore)
  const takeDraftRestore = useStore((s) => s.takeDraftRestore)
  // Messages the harness is holding. Display-only: the protocol has no command to
  // withdraw one once it's queued.
  const queued = useStore(
    useShallow((s) => {
      const id = selectCurrentRunId(s)
      const q = id ? s.runs[id]?.queued : undefined
      return [...(q?.steering ?? []), ...(q?.followUp ?? [])]
    })
  )
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

  // The harness refused a prompt (e.g. the turn ended between keypress and write).
  // Put the text back rather than losing it.
  useEffect(() => {
    if (!draftRestore) return
    const restored = takeDraftRestore()
    if (restored) setText((cur) => cur || restored)
  }, [draftRestore, takeDraftRestore])

  const submit = (behavior?: 'steer' | 'followUp') => {
    const t = text.trim()
    if (!t || !canSend) return
    setText('')
    void sendPrompt(t, behavior)
  }

  const placeholder = !canSend
    ? 'Viewing only — no RPC launcher for this harness'
    : running
      ? 'Queue a follow-up…  (⌘↩ to steer this turn)'
      : 'Fire up the forge…'

  return (
    <div className="composer">
      {showAttach && (
        <div className={`attach-bar ${attachViewedFile ? 'on' : 'off'}`}>
          <Paperclip size={ICON.xs} />
          {attachViewedFile ? (
            <>
              <span>
                Referencing <span className="copper">{basename(selectedFile as string)}</span> — the agent
                will know you mean this file
              </span>
              <button className="attach-toggle" title="Don't attach" onClick={() => setAttachViewedFile(false)}>
                <X size={ICON.xs} />
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
      {queued.length > 0 && (
        <div className="queue-bar" title="Held by the agent; it will run these in order">
          {queued.map((q, i) => (
            <span className="queue-chip" key={i}>
              <CornerDownRight size={ICON.xs} />
              {q.length > 60 ? `${q.slice(0, 60)}…` : q}
            </span>
          ))}
        </div>
      )}
      <div className="box">
        <textarea
          ref={taRef}
          rows={1}
          placeholder={placeholder}
          value={text}
          // Enabled during a turn: the message queues instead of being lost.
          disabled={!canSend}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault()
              // While streaming, ⌘/Ctrl+Enter steers the current turn; plain Enter
              // queues a follow-up for the next one.
              submit(running ? (e.metaKey || e.ctrlKey ? 'steer' : 'followUp') : undefined)
            }
          }}
        />
        {running && (
          <button className="send-btn ghost-btn" title="Stop this turn" onClick={() => void abort()}>
            <Square size={ICON.md} />
          </button>
        )}
        <button
          className="send-btn"
          title={running ? 'Queue as a follow-up (⌘↩ to steer)' : 'Send'}
          disabled={!canSend || !text.trim()}
          onClick={() => submit(running ? 'followUp' : undefined)}
        >
          <Send size={ICON.md} />
        </button>
      </div>
      {!canSend && selectedCwd && (
        <div className="note">
          This harness has no resolved CLI launcher, so prompts are disabled. Browsing and tracking still work.
        </div>
      )}
    </div>
  )
}

/**
 * Tool arguments, capped. A `write` call carries the entire file it is writing, so
 * rendering these verbatim put an unbounded amount of text on screen — the same
 * bound the tool *results* already had.
 */
function formatArgs(args: unknown): string {
  if (args && typeof args === 'object' && 'command' in args) {
    return truncate(String((args as { command: unknown }).command), 6000)
  }
  try {
    return truncate(JSON.stringify(args, null, 2), 6000)
  } catch {
    return truncate(String(args), 6000)
  }
}

function truncate(s: string, n: number): string {
  return s.length > n ? s.slice(0, n) + `\n… (${s.length - n} more chars)` : s
}

function basename(p: string): string {
  return p.split('/').pop() ?? p
}
