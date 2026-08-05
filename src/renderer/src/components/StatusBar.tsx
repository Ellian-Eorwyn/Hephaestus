import { useShallow } from 'zustand/react/shallow'
import { useStore, countActive, selectCurrentRunId } from '../store/store'
import { StackChip } from './StackChip'
import type { StatsPatch } from '@shared/types'

function fmt(n: number): string {
  if (n >= 1000) return `${(n / 1000).toFixed(1)}k`
  return String(n)
}

function fmtRate(n: number): string {
  return n >= 100 ? String(Math.round(n)) : n.toFixed(1)
}

function fmtCost(n: number): string {
  if (n === 0) return '$0'
  if (n < 0.01) return `$${n.toFixed(4)}`
  return `$${n.toFixed(2)}`
}

export function StatusBar(): JSX.Element {
  const session = useStore((s) => s.session)
  const view = useStore((s) => s.view)
  const backend = useStore((s) => s.backend)
  // A count, not the runs map — the status bar shouldn't repaint as text streams.
  const runningCount = useStore((s) => countActive(s.runs))
  const reconnecting = useStore((s) => s.reconnecting)

  // Live throughput for the run feeding the viewed session, plus whatever
  // authoritative totals the harness last reported for it.
  const live = useStore(
    useShallow((s): StatsPatch => {
      const id = selectCurrentRunId(s)
      return (id ? s.statsLive[id] : undefined) ?? {}
    })
  )
  const finalStats = useStore(
    useShallow((s): StatsPatch => {
      const p = s.selectedSessionPath
      return (p ? s.sessionStats[p] : undefined) ?? {}
    })
  )

  const harnessId = view === 'dashboard' ? null : view.harnessId
  const health = harnessId ? backend[harnessId] : undefined

  // Prefer the harness's own context accounting; fall back to the estimate
  // derived from the session file when it isn't available.
  const ctxWindow = finalStats.contextWindow ?? session?.contextWindow ?? null
  const ctxUsed = finalStats.contextTokens ?? session?.currentContextTokens ?? 0
  const pct =
    finalStats.contextPercent ?? (ctxWindow ? Math.min(100, (ctxUsed / ctxWindow) * 100) : 0)
  const total = session?.usage.totalTokens ?? 0
  const cost = finalStats.cost ?? session?.usage.cost ?? 0

  // On the Dashboard there is no single active harness, so summarize all of them.
  const allHealth = Object.values(backend)
  const liveCount = allHealth.filter((h) => h.status !== 'offline').length

  const status = health?.status
  const dotClass = status === 'online' ? 'online' : status === 'ready' ? 'ready' : 'offline'
  const label =
    status === 'online'
      ? 'BACKEND ONLINE'
      : status === 'ready'
        ? 'HARNESS READY'
        : status === 'offline'
          ? 'BACKEND OFFLINE'
          : 'NO BACKEND'

  return (
    <footer className="statusbar">
      {harnessId ? (
        <span>
          <span className={`dot ${dotClass}`} />
          {label}
        </span>
      ) : (
        <span>
          <span className={`dot ${liveCount > 0 ? 'online' : 'offline'}`} />
          {liveCount}/{allHealth.length || 0} HARNESSES LIVE
        </span>
      )}
      {health?.online && health.models[0] && <span className="muted">{health.models[0]}</span>}
      {/* The machine behind that backend, when the stack monitor is configured. */}
      <StackChip />
      {runningCount > 0 && (
        <span className="copper">● {runningCount > 1 ? `${runningCount} RUNNING` : 'RUNNING'}</span>
      )}
      {reconnecting && <span className="muted">reconnecting…</span>}

      {/* Live throughput. `~` marks a figure we measured rather than one the
          harness reported, so the two are never confused. */}
      {live.tokPerSec !== undefined && (
        <span
          className="copper"
          title={
            live.approx
              ? 'Measured from output tokens ÷ generation time (this harness does not report throughput)'
              : 'Reported by the inference backend'
          }
        >
          ⚡ {live.approx ? '~' : ''}
          {fmtRate(live.tokPerSec)} tok/s
        </span>
      )}
      {live.ttftMs !== undefined && live.ttftMs > 0 && (
        <span
          className="muted"
          title={
            live.approx
              ? 'Time to first token, measured from when the prompt was sent (includes harness overhead)'
              : "Time to first token, as reported by the backend (the model's own prefill)"
          }
        >
          TTFT {live.approx ? '~' : ''}
          {live.ttftMs >= 1000 ? `${(live.ttftMs / 1000).toFixed(1)}s` : `${Math.round(live.ttftMs)}ms`}
        </span>
      )}
      {live.acceptanceRate !== undefined && (
        <span className="muted" title="Speculative-decode acceptance rate">
          MTP {Math.round(live.acceptanceRate * 100)}%
        </span>
      )}

      <span className="spacer" />
      {session && (
        <>
          <span>SESSION TOTAL: {fmt(total)} tok</span>
          {cost > 0 && <span title="Cumulative cost for this session">{fmtCost(cost)}</span>}
          {ctxWindow && (
            <span className="ctx-gauge">
              CTX
              <span className="ctx-bar">
                <span style={{ width: `${pct}%` }} />
              </span>
              {fmt(ctxUsed)} / {fmt(ctxWindow)}
            </span>
          )}
        </>
      )}
    </footer>
  )
}
