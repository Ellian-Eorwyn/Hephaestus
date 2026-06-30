import { useEffect, useRef, useState } from 'react'
import { Send, Square, Hammer, Flame, Paperclip, X } from 'lucide-react'
import { useStore } from '../store/store'
import { MarkdownView } from './MarkdownView'
import type { ThreadMessage } from '@shared/types'

export function Forge(): JSX.Element {
  const session = useStore((s) => s.session)
  const loading = useStore((s) => s.loadingSession)
  const streamingText = useStore((s) => s.streamingText)
  const streamingThinking = useStore((s) => s.streamingThinking)
  const agentStatus = useStore((s) => s.agentStatus)
  const selectedSessionPath = useStore((s) => s.selectedSessionPath)
  const selectedCwd = useStore((s) => s.selectedCwd)
  const messageSpacing = useStore((s) => s.messageSpacing)
  const bottomRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [session?.messages.length, streamingText])

  if (!selectedSessionPath && !selectedCwd) {
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

  if (!selectedSessionPath && selectedCwd) {
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
        <span className="label-tech">Forge — Session</span>
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
            {agentStatus === 'running' && (streamingText || streamingThinking) && (
              <div className="msg assistant">
                <div className="avatar">
                  <Hammer size={15} />
                </div>
                <div className="body">
                  {streamingThinking && !streamingText && (
                    <details className="thinking" open>
                      <summary>✦ thinking</summary>
                      <div className="content">{streamingThinking}</div>
                    </details>
                  )}
                  {streamingText && <MarkdownView source={streamingText} />}
                  <span className="muted">▍</span>
                </div>
              </div>
            )}
            <div ref={bottomRef} />
          </div>
        )}
      </div>
      <Composer />
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
  return (
    <div className="msg assistant">
      <div className="avatar">
        <Hammer size={15} />
      </div>
      <div className="body">
        {m.thinking && showThinking && (
          <details className="thinking">
            <summary>✦ thinking</summary>
            <div className="content">{m.thinking}</div>
          </details>
        )}
        {m.text && <MarkdownView source={m.text} />}
        {m.toolCalls && showTools && m.toolCalls.map((tc) => (
          <details className="toolblock" key={tc.id}>
            <summary>⚙ {tc.name}</summary>
            <div className="content">
              <div className="toolargs">{formatArgs(tc.arguments)}</div>
            </div>
          </details>
        ))}
      </div>
    </div>
  )
}

function Composer(): JSX.Element {
  const [text, setText] = useState('')
  const sendPrompt = useStore((s) => s.sendPrompt)
  const abort = useStore((s) => s.abort)
  const agentStatus = useStore((s) => s.agentStatus)
  const harnesses = useStore((s) => s.harnesses)
  const view = useStore((s) => s.view)
  const selectedCwd = useStore((s) => s.selectedCwd)
  const selectedFile = useStore((s) => s.selectedFile)
  const attachViewedFile = useStore((s) => s.attachViewedFile)
  const setAttachViewedFile = useStore((s) => s.setAttachViewedFile)

  const harnessId = view === 'dashboard' ? null : view.harnessId
  const harness = harnesses.find((h) => h.id === harnessId)
  const canSend = !!harness?.cli && !!selectedCwd
  const showAttach = canSend && !!selectedFile

  const submit = () => {
    const t = text.trim()
    if (!t || !canSend) return
    void sendPrompt(t)
    setText('')
  }

  const running = agentStatus === 'running'

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
