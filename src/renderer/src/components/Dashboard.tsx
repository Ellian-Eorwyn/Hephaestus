import { useEffect, useState } from 'react'
import { Activity, FolderGit2, MessagesSquare } from 'lucide-react'
import { useStore } from '../store/store'
import { BallPeenHammer } from './BallPeenHammer'
import type { ProjectSummary } from '@shared/types'

interface HarnessStats {
  id: string
  label: string
  projects: number
  sessions: number
  tokens: number
  recent: { title: string; cwd: string; path: string }[]
}

export function Dashboard(): JSX.Element {
  const harnesses = useStore((s) => s.harnesses)
  const backend = useStore((s) => s.backend)
  const setView = useStore((s) => s.setView)
  const selectSession = useStore((s) => s.selectSession)
  const [stats, setStats] = useState<HarnessStats[]>([])

  useEffect(() => {
    let cancelled = false
    Promise.all(
      harnesses.map(async (h) => {
        const projects = await window.heph.listProjects(h.id)
        return { h, projects }
      })
    ).then((results) => {
      if (cancelled) return
      setStats(
        results.map(({ h, projects }) => buildStats(h.id, h.label, projects))
      )
    })
    return () => {
      cancelled = true
    }
  }, [harnesses])

  return (
    <div className="dashboard">
      <h1 style={{ fontSize: 30, margin: 0, color: 'var(--copper-bright)' }}>The Workshop</h1>
      <p className="muted" style={{ marginTop: 4 }}>
        Overview across {harnesses.length} registered {harnesses.length === 1 ? 'harness' : 'harnesses'}.
      </p>
      <div className="dash-grid">
        {stats.map((s) => {
          const health = backend[s.id]
          const status = health?.status
          const statusColor =
            status === 'online'
              ? 'var(--green)'
              : status === 'offline'
                ? 'var(--copper-dim)'
                : 'var(--text-faint)'
          const statusLabel = status === 'ready' ? 'ready' : (status ?? 'offline')
          return (
            <div className="card" key={s.id}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <BallPeenHammer size={16} className="copper" />
                <h3>{s.label}</h3>
                <span
                  className="label-tech"
                  style={{ marginLeft: 'auto', color: statusColor }}
                >
                  <Activity size={11} /> {statusLabel}
                </span>
              </div>
              <div style={{ display: 'flex', gap: 20, margin: '16px 0' }}>
                <Metric icon={<FolderGit2 size={13} />} label="projects" value={s.projects} />
                <Metric icon={<MessagesSquare size={13} />} label="sessions" value={s.sessions} />
                <Metric label="tokens" value={fmt(s.tokens)} />
              </div>
              <div className="label-tech" style={{ marginBottom: 6 }}>
                Recent
              </div>
              {s.recent.length === 0 && <div className="muted">No sessions yet.</div>}
              {s.recent.map((r) => (
                <div
                  key={r.path}
                  className="session-row"
                  style={{ paddingLeft: 0 }}
                  onClick={() => {
                    setView({ harnessId: s.id })
                    void selectSession(s.id, r.path, r.cwd)
                  }}
                >
                  <span className="stitle" title={r.title}>
                    {r.title}
                  </span>
                </div>
              ))}
              <button
                className="btn"
                style={{ marginTop: 14, width: '100%' }}
                onClick={() => setView({ harnessId: s.id })}
              >
                Open workspace
              </button>
            </div>
          )
        })}
      </div>
    </div>
  )
}

function Metric({ icon, label, value }: { icon?: JSX.Element; label: string; value: number | string }): JSX.Element {
  return (
    <div>
      <div className="stat">{value}</div>
      <div className="label-tech">
        {icon} {label}
      </div>
    </div>
  )
}

function buildStats(id: string, label: string, projects: ProjectSummary[]): HarnessStats {
  let sessions = 0
  let tokens = 0
  const recent: HarnessStats['recent'] = []
  for (const p of projects) {
    sessions += p.sessions.length
    for (const s of p.sessions) {
      tokens += s.totalTokens
      recent.push({ title: s.title, cwd: p.cwd, path: s.path })
    }
  }
  recent.sort(() => 0) // already roughly newest-first per project; keep order
  return { id, label, projects: projects.length, sessions, tokens, recent: recent.slice(0, 4) }
}

function fmt(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`
  if (n >= 1000) return `${(n / 1000).toFixed(1)}k`
  return String(n)
}
