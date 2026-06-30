import { ChevronRight, ChevronDown, MessageSquare, Folder, Hammer } from 'lucide-react'
import { useStore } from '../store/store'

function formatTokens(n: number): string {
  if (n >= 1000) return `${(n / 1000).toFixed(1)}k`
  return String(n)
}

export function Projects(): JSX.Element {
  const projects = useStore((s) => s.projects)
  const expanded = useStore((s) => s.expanded)
  const toggleProject = useStore((s) => s.toggleProject)
  const selectSession = useStore((s) => s.selectSession)
  const selectedSessionPath = useStore((s) => s.selectedSessionPath)
  const harnesses = useStore((s) => s.harnesses)
  const view = useStore((s) => s.view)

  const harnessId = view === 'dashboard' ? null : view.harnessId
  const harness = harnesses.find((h) => h.id === harnessId)

  return (
    <div className="pane">
      <div className="pane-header">
        <span className="label-tech">Projects</span>
      </div>
      <div className="pane-body">
        {projects.length === 0 && (
          <div className="empty" style={{ height: 'auto', padding: '40px 20px' }}>
            <div>
              <Folder size={28} className="muted" />
              <p className="muted" style={{ marginTop: 10 }}>
                No conversations found for this harness yet.
              </p>
            </div>
          </div>
        )}
        {projects.map((p) => {
          const open = !!expanded[p.encoded]
          return (
            <div className="project" key={p.encoded}>
              <div className="project-row" onClick={() => toggleProject(p)}>
                {open ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
                <span className="pname" title={p.cwd}>
                  {p.name}
                </span>
                <span className="pmeta">{p.sessions.length}</span>
              </div>
              {open &&
                p.sessions.map((sess) => (
                  <div
                    key={sess.path}
                    className={`session-row ${selectedSessionPath === sess.path ? 'active' : ''}`}
                    onClick={() => harnessId && selectSession(harnessId, sess.path, p.cwd)}
                  >
                    <MessageSquare size={13} className="muted" />
                    <span className="stitle" title={sess.title}>
                      {sess.title}
                    </span>
                    {sess.totalTokens > 0 && <span className="stoks">{formatTokens(sess.totalTokens)}</span>}
                  </div>
                ))}
            </div>
          )
        })}
      </div>
      <div className="active-harness">
        <div className="crest">
          <Hammer size={15} />
        </div>
        <div>
          <div className="label-tech" style={{ fontSize: 9 }}>
            Active Harness
          </div>
          <div style={{ color: 'var(--text-0)', fontSize: 13 }}>{harness?.label ?? '—'}</div>
        </div>
      </div>
    </div>
  )
}
