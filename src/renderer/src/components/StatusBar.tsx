import { useStore } from '../store/store'

function fmt(n: number): string {
  if (n >= 1000) return `${(n / 1000).toFixed(1)}k`
  return String(n)
}

export function StatusBar(): JSX.Element {
  const session = useStore((s) => s.session)
  const view = useStore((s) => s.view)
  const backend = useStore((s) => s.backend)
  const agentStatus = useStore((s) => s.agentStatus)

  const harnessId = view === 'dashboard' ? null : view.harnessId
  const health = harnessId ? backend[harnessId] : undefined

  const ctxWindow = session?.contextWindow ?? null
  const ctxUsed = session?.currentContextTokens ?? 0
  const pct = ctxWindow ? Math.min(100, (ctxUsed / ctxWindow) * 100) : 0
  const total = session?.usage.totalTokens ?? 0

  return (
    <footer className="statusbar">
      <span>
        <span className={`dot ${health?.online ? 'online' : 'offline'}`} />
        {health ? (health.online ? 'BACKEND ONLINE' : 'BACKEND OFFLINE') : 'NO BACKEND'}
      </span>
      {health?.online && health.models[0] && <span className="muted">{health.models[0]}</span>}
      {agentStatus === 'running' && <span className="copper">● RUNNING</span>}
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
