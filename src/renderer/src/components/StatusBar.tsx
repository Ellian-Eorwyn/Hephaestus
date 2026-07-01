import { useStore, isActive } from '../store/store'

function fmt(n: number): string {
  if (n >= 1000) return `${(n / 1000).toFixed(1)}k`
  return String(n)
}

export function StatusBar(): JSX.Element {
  const session = useStore((s) => s.session)
  const view = useStore((s) => s.view)
  const backend = useStore((s) => s.backend)
  const runs = useStore((s) => s.runs)
  const reconnecting = useStore((s) => s.reconnecting)

  const harnessId = view === 'dashboard' ? null : view.harnessId
  const health = harnessId ? backend[harnessId] : undefined
  const runningCount = Object.values(runs).filter((r) => isActive(r.status)).length

  const ctxWindow = session?.contextWindow ?? null
  const ctxUsed = session?.currentContextTokens ?? 0
  const pct = ctxWindow ? Math.min(100, (ctxUsed / ctxWindow) * 100) : 0
  const total = session?.usage.totalTokens ?? 0

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
      {runningCount > 0 && (
        <span className="copper">● {runningCount > 1 ? `${runningCount} RUNNING` : 'RUNNING'}</span>
      )}
      {reconnecting && <span className="muted">reconnecting…</span>}
      <span className="spacer" />
      {session && (
        <>
          <span>SESSION TOTAL: {fmt(total)} tok</span>
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
