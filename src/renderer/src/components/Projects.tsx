import { useState } from 'react'
import {
  ChevronRight,
  ChevronDown,
  MessageSquare,
  Folder,
  FolderPlus,
  Hammer,
  Plus,
  CheckSquare,
  Square,
  Archive,
  ArchiveRestore,
  Trash2,
  X
} from 'lucide-react'
import { useStore, projectKey, samePath, isActive } from '../store/store'
import { ICON } from '../lib/icons'
import { ForgeAnvil } from './ForgeAnvil'
import type { ProjectSummary, SessionSummary } from '@shared/types'

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
  const browseAndAddProject = useStore((s) => s.browseAndAddProject)
  const addProject = useStore((s) => s.addProject)

  const [dragOver, setDragOver] = useState(false)

  const harnessId = view === 'dashboard' ? null : view.harnessId
  const harness = harnesses.find((h) => h.id === harnessId)

  const isArchived = (p: ProjectSummary) =>
    harnessId ? archived.includes(projectKey(harnessId, p.encoded)) : false
  const activeProjects = projects.filter((p) => !isArchived(p))
  const archivedProjects = projects.filter((p) => isArchived(p))

  const handleDragOver = (e: React.DragEvent) => {
    e.preventDefault()
    e.stopPropagation()
    setDragOver(true)
  }
  const handleDragLeave = (e: React.DragEvent) => {
    e.preventDefault()
    e.stopPropagation()
    setDragOver(false)
  }
  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault()
    e.stopPropagation()
    setDragOver(false)
    const items = e.dataTransfer.items
    const files = e.dataTransfer.files
    for (let i = 0; i < files.length; i++) {
      const file = files[i]
      // Only add folders, not loose files. A dropped directory has an empty MIME
      // type and (via the items list) kind 'file' with a directory entry.
      const entry = items[i]?.webkitGetAsEntry?.()
      if (entry && !entry.isDirectory) continue
      // Electron 32+ removed File.path; resolve via webUtils (with a legacy fallback).
      const filePath =
        window.heph.getPathForFile?.(file) ?? (file as unknown as { path?: string }).path
      if (filePath) void addProject(filePath)
    }
  }

  return (
    <div
      className="pane"
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
    >
      <div className="pane-header">
        <span className="label-tech">Projects</span>
        <div style={{ marginLeft: 'auto', display: 'flex', gap: 2 }}>
          <button
            className="icon-btn sm"
            title="Add project folder"
            onClick={() => void browseAndAddProject()}
          >
            <FolderPlus size={ICON.md} />
          </button>
          {activeProjects.length > 0 && (
            <button
              className="icon-btn sm"
              title={selectionMode ? 'Cancel selection' : 'Select projects to archive'}
              onClick={toggleSelectionMode}
            >
              {selectionMode ? <X size={ICON.md} /> : <CheckSquare size={ICON.md} />}
            </button>
          )}
        </div>
      </div>

      <div className="pane-body">
        {dragOver && (
          <div className="drop-zone-overlay">
            <FolderPlus size={ICON.xl} />
            <span>Drop folder to add project</span>
          </div>
        )}

        {activeProjects.length === 0 && archivedProjects.length === 0 && (
          <div className="empty" style={{ height: 'auto', padding: '40px 20px' }}>
            <div>
              <Folder size={ICON.xl} className="muted" />
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
            <Archive size={ICON.xs} /> Archive
          </button>
        </div>
      )}

      <div className="active-harness">
        <div className="crest">
          <Hammer size={ICON.lg} />
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
  const selectProject = useStore((s) => s.selectProject)
  const startNewChat = useStore((s) => s.startNewChat)
  const selectSession = useStore((s) => s.selectSession)
  const selectedSessionPath = useStore((s) => s.selectedSessionPath)
  const selectedCwd = useStore((s) => s.selectedCwd)
  const selectionMode = useStore((s) => s.selectionMode)
  const selectedForArchive = useStore((s) => s.selectedForArchive)
  const toggleForArchive = useStore((s) => s.toggleForArchive)
  const unarchive = useStore((s) => s.unarchive)
  const deleteProject = useStore((s) => s.deleteProject)

  // A boolean rather than the whole runs map, so a streaming turn doesn't
  // re-render every project row on every frame of output.
  const projectRunning = useStore((s) => {
    for (const id in s.runs) {
      const r = s.runs[id]
      if (isActive(r.status) && samePath(r.cwd, p.cwd)) return true
    }
    return false
  })

  const key = harnessId ? projectKey(harnessId, p.encoded) : p.encoded
  const open = !!expanded[p.encoded] && !selectionMode
  const checked = selectedForArchive.includes(key)
  const isSelected = samePath(selectedCwd, p.cwd)

  const onRowClick = () => {
    if (selectionMode && !archived) {
      toggleForArchive(key)
    } else {
      toggleProject(p)
      // Always load the file tree when clicking a project
      void selectProject(p.cwd)
    }
  }

  return (
    <div className="project">
      <div className={`project-row ${checked ? 'checked' : ''} ${isSelected && !selectionMode ? 'selected' : ''}`} onClick={onRowClick}>
        {selectionMode && !archived ? (
          checked ? (
            <CheckSquare size={ICON.sm} className="copper" />
          ) : (
            <Square size={ICON.sm} className="muted" />
          )
        ) : open ? (
          <ChevronDown size={ICON.sm} />
        ) : (
          <ChevronRight size={ICON.sm} />
        )}
        <span className="pname" title={p.cwd}>
          {p.name}
        </span>
        {projectRunning && (
          <span className="run-badge" title="Agent is working in this project">
            <ForgeAnvil size={ICON.md} />
          </span>
        )}
        {archived ? (
          <div className="project-actions">
            <button
              className="restore-btn"
              title="Restore from archive"
              onClick={(e) => {
                e.stopPropagation()
                unarchive(key)
              }}
            >
              <ArchiveRestore size={ICON.sm} />
            </button>
            <button
              className="restore-btn"
              title="Delete from list"
              onClick={(e) => {
                e.stopPropagation()
                void deleteProject(p.encoded)
              }}
            >
              <Trash2 size={ICON.sm} />
            </button>
          </div>
        ) : (
          <div className="project-actions">
            <button
              className="new-chat-btn"
              title="Start new chat"
              onClick={(e) => {
                e.stopPropagation()
                void startNewChat(p.cwd)
              }}
            >
              <Plus size={ICON.sm} />
            </button>
            <span className="pmeta">{p.sessions.length}</span>
          </div>
        )}
      </div>
      {open &&
        p.sessions.map((sess) => (
          <SessionRow
            key={sess.path}
            session={sess}
            active={selectedSessionPath === sess.path}
            onClick={() => harnessId && selectSession(harnessId, sess.path, p.cwd)}
          />
        ))}
    </div>
  )
}

/**
 * One session in the sidebar. Its own subscription is a single boolean, so a
 * streaming turn repaints at most the row it belongs to.
 */
function SessionRow({
  session: sess,
  active,
  onClick
}: {
  session: SessionSummary
  active: boolean
  onClick: () => void
}): JSX.Element {
  const running = useStore((s) => {
    for (const id in s.runs) {
      const r = s.runs[id]
      if (isActive(r.status) && samePath(r.sessionPath, sess.path)) return true
    }
    return false
  })
  return (
    <div className={`session-row ${active ? 'active' : ''}`} onClick={onClick}>
      <MessageSquare size={ICON.sm} className="muted" />
      <span className="stitle" title={sess.title}>
        {sess.title}
      </span>
      {running && <span className="run-dot" title="Working" />}
      {sess.totalTokens > 0 && <span className="stoks">{formatTokens(sess.totalTokens)}</span>}
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
        {open ? <ChevronDown size={ICON.sm} /> : <ChevronRight size={ICON.sm} />}
        <Archive size={ICON.sm} />
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
