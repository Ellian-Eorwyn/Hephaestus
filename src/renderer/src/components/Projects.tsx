import { useState } from 'react'
import {
  ChevronRight,
  ChevronDown,
  MessageSquare,
  Folder,
  Hammer,
  CheckSquare,
  Square,
  Archive,
  ArchiveRestore,
  X
} from 'lucide-react'
import { useStore, projectKey } from '../store/store'
import type { ProjectSummary } from '@shared/types'

function formatTokens(n: number): string {
  if (n >= 1000) return `${(n / 1000).toFixed(1)}k`
  return String(n)
}

export function Projects(): JSX.Element {
  const projects = useStore((s) => s.projects)
  const harnesses = useStore((s) => s.harnesses)
  const view = useStore((s) => s.view)
  const archived = useStore((s) => s.archived)
  const selectionMode = useStore((s) => s.selectionMode)
  const selectedForArchive = useStore((s) => s.selectedForArchive)
  const toggleSelectionMode = useStore((s) => s.toggleSelectionMode)
  const archiveSelected = useStore((s) => s.archiveSelected)

  const harnessId = view === 'dashboard' ? null : view.harnessId
  const harness = harnesses.find((h) => h.id === harnessId)

  const isArchived = (p: ProjectSummary) =>
    harnessId ? archived.includes(projectKey(harnessId, p.encoded)) : false
  const activeProjects = projects.filter((p) => !isArchived(p))
  const archivedProjects = projects.filter((p) => isArchived(p))

  return (
    <div className="pane">
      <div className="pane-header">
        <span className="label-tech">Projects</span>
        {activeProjects.length > 0 && (
          <button
            className="icon-btn"
            style={{ marginLeft: 'auto', width: 26, height: 26 }}
            title={selectionMode ? 'Cancel selection' : 'Select projects to archive'}
            onClick={toggleSelectionMode}
          >
            {selectionMode ? <X size={15} /> : <CheckSquare size={15} />}
          </button>
        )}
      </div>

      <div className="pane-body">
        {activeProjects.length === 0 && archivedProjects.length === 0 && (
          <div className="empty" style={{ height: 'auto', padding: '40px 20px' }}>
            <div>
              <Folder size={28} className="muted" />
              <p className="muted" style={{ marginTop: 10 }}>
                No conversations found for this harness yet.
              </p>
            </div>
          </div>
        )}

        {activeProjects.map((p) => (
          <ProjectRow key={p.encoded} project={p} harnessId={harnessId} archived={false} />
        ))}

        {archivedProjects.length > 0 && (
          <ArchiveSection projects={archivedProjects} harnessId={harnessId} />
        )}
      </div>

      {selectionMode && (
        <div className="select-bar">
          <span className="muted">{selectedForArchive.length} selected</span>
          <button
            className="btn primary"
            style={{ marginLeft: 'auto', padding: '5px 12px' }}
            disabled={selectedForArchive.length === 0}
            onClick={archiveSelected}
          >
            <Archive size={12} /> Archive
          </button>
        </div>
      )}

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

function ProjectRow({
  project: p,
  harnessId,
  archived
}: {
  project: ProjectSummary
  harnessId: string | null
  archived: boolean
}): JSX.Element {
  const expanded = useStore((s) => s.expanded)
  const toggleProject = useStore((s) => s.toggleProject)
  const selectSession = useStore((s) => s.selectSession)
  const selectedSessionPath = useStore((s) => s.selectedSessionPath)
  const selectionMode = useStore((s) => s.selectionMode)
  const selectedForArchive = useStore((s) => s.selectedForArchive)
  const toggleForArchive = useStore((s) => s.toggleForArchive)
  const unarchive = useStore((s) => s.unarchive)

  const key = harnessId ? projectKey(harnessId, p.encoded) : p.encoded
  const open = !!expanded[p.encoded] && !selectionMode
  const checked = selectedForArchive.includes(key)

  const onRowClick = () => {
    if (selectionMode && !archived) {
      toggleForArchive(key)
    } else {
      toggleProject(p)
    }
  }

  return (
    <div className="project">
      <div className={`project-row ${checked ? 'checked' : ''}`} onClick={onRowClick}>
        {selectionMode && !archived ? (
          checked ? (
            <CheckSquare size={14} className="copper" />
          ) : (
            <Square size={14} className="muted" />
          )
        ) : open ? (
          <ChevronDown size={14} />
        ) : (
          <ChevronRight size={14} />
        )}
        <span className="pname" title={p.cwd}>
          {p.name}
        </span>
        {archived ? (
          <button
            className="restore-btn"
            title="Restore from archive"
            onClick={(e) => {
              e.stopPropagation()
              unarchive(key)
            }}
          >
            <ArchiveRestore size={13} />
          </button>
        ) : (
          <span className="pmeta">{p.sessions.length}</span>
        )}
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
}

function ArchiveSection({
  projects,
  harnessId
}: {
  projects: ProjectSummary[]
  harnessId: string | null
}): JSX.Element {
  const [open, setOpen] = useState(false)
  return (
    <div className="archive-section">
      <div className="archive-header" onClick={() => setOpen(!open)}>
        {open ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
        <Archive size={13} />
        <span className="label-tech">Archive</span>
        <span className="pmeta">{projects.length}</span>
      </div>
      {open &&
        projects.map((p) => (
          <ProjectRow key={p.encoded} project={p} harnessId={harnessId} archived={true} />
        ))}
    </div>
  )
}
