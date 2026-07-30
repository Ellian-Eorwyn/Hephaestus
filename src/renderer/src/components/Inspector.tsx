import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { Panel, PanelGroup, PanelResizeHandle } from 'react-resizable-panels'
import {
  ChevronRight,
  ChevronDown,
  FileText,
  FileCode,
  FileSpreadsheet,
  File as FileIcon,
  Folder,
  FolderOpen,
  Files,
  Eye,
  RefreshCw,
  PanelBottom,
  PanelRight,
  AlertTriangle
} from 'lucide-react'
import { useStore } from '../store/store'
import { MarkdownView } from './MarkdownView'
import { CodeView } from './CodeView'
import { SpreadsheetView } from './SpreadsheetView'
import type { FileNode } from '@shared/types'

export function Inspector({ dock }: { dock: 'right' | 'bottom' }): JSX.Element {
  const isBottom = dock === 'bottom'
  return (
    <div className="pane">
      <PanelGroup
        direction={isBottom ? 'horizontal' : 'vertical'}
        autoSaveId={isBottom ? 'heph-inspector-h' : 'heph-inspector'}
      >
        <Panel defaultSize={isBottom ? 30 : 42} minSize={15}>
          <FileBrowser />
        </Panel>
        <PanelResizeHandle className="rrp-handle" />
        <Panel defaultSize={isBottom ? 70 : 58} minSize={20}>
          <Preview />
        </Panel>
      </PanelGroup>
    </div>
  )
}

function FileBrowser(): JSX.Element {
  const fileTree = useStore((s) => s.fileTree)
  const selectedCwd = useStore((s) => s.selectedCwd)
  const refreshFiles = useStore((s) => s.refreshFiles)
  const inspectorDock = useStore((s) => s.inspectorDock)
  const toggleInspectorDock = useStore((s) => s.toggleInspectorDock)

  return (
    <div className="pane">
      <div className="pane-header">
        <Files size={14} className="copper" />
        <span className="label-tech">Files</span>
        {selectedCwd && (
          <span
            className="muted"
            style={{ marginLeft: 'auto', maxWidth: 170, fontSize: 10, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}
            title={selectedCwd}
          >
            {selectedCwd}
          </span>
        )}
        <button
          className="icon-btn dock-toggle"
          style={{ marginLeft: selectedCwd ? 6 : 'auto', width: 24, height: 24 }}
          title={inspectorDock === 'right' ? 'Dock panel to bottom' : 'Dock panel to right'}
          onClick={toggleInspectorDock}
        >
          {inspectorDock === 'right' ? <PanelBottom size={13} /> : <PanelRight size={13} />}
        </button>
        <button
          className="icon-btn"
          style={{ width: 24, height: 24 }}
          title="Refresh files"
          disabled={!selectedCwd}
          onClick={() => void refreshFiles()}
        >
          <RefreshCw size={13} />
        </button>
      </div>
      <div className="pane-body">
        {fileTree.length === 0 ? (
          <div className="empty" style={{ height: 'auto', padding: 30 }}>
            <span className="muted">No project selected</span>
          </div>
        ) : (
          <div className="filetree">
            {fileTree.map((n) => (
              <TreeNode key={n.path} node={n} depth={0} />
            ))}
          </div>
        )}
      </div>
    </div>
  )
}

/** How long a row stays highlighted after the agent writes to it. */
const EDIT_FLASH_MS = 4000

function TreeNode({ node, depth }: { node: FileNode; depth: number }): JSX.Element {
  const [open, setOpen] = useState(depth < 1)
  const selectFile = useStore((s) => s.selectFile)
  const selectedFile = useStore((s) => s.selectedFile)
  // A single timestamp for this row — a primitive, so an edit elsewhere in the
  // tree doesn't re-render every other node.
  const editedAt = useStore((s) => (node.type === 'file' ? (s.agentEdits[node.path] ?? 0) : 0))
  const flash = useEditFlash(editedAt)

  if (node.type === 'dir') {
    return (
      <div>
        <div className="filenode" style={{ paddingLeft: 14 + depth * 14 }} onClick={() => setOpen(!open)}>
          <span className="chev">{open ? <ChevronDown size={12} /> : <ChevronRight size={12} />}</span>
          {open ? <FolderOpen size={14} className="copper" /> : <Folder size={14} className="muted" />}
          <span>{node.name}</span>
        </div>
        {open && node.children?.map((c) => <TreeNode key={c.path} node={c} depth={depth + 1} />)}
      </div>
    )
  }
  return (
    <div
      className={`filenode ${selectedFile === node.path ? 'active' : ''} ${flash ? 'agent-edited' : ''}`}
      style={{ paddingLeft: 14 + depth * 14 + 18 }}
      onClick={() => void selectFile(node.path)}
      title={flash ? 'Just edited by the agent' : undefined}
    >
      <FileGlyph name={node.name} />
      <span>{node.name}</span>
    </div>
  )
}

/** True for a few seconds after `editedAt`, then clears itself. */
function useEditFlash(editedAt: number): boolean {
  const [, tick] = useState(0)
  const fresh = editedAt > 0 && Date.now() - editedAt < EDIT_FLASH_MS
  useEffect(() => {
    if (!fresh) return
    const t = setTimeout(() => tick((n) => n + 1), EDIT_FLASH_MS - (Date.now() - editedAt) + 50)
    return () => clearTimeout(t)
  }, [editedAt, fresh])
  return fresh
}

function FileGlyph({ name }: { name: string }): JSX.Element {
  if (/\.(md|markdown|mdx)$/i.test(name)) return <FileText size={14} className="muted" />
  if (/\.(csv|tsv|xlsx|xlsm|xls|ods|jsonl|ndjson)$/i.test(name)) return <FileSpreadsheet size={14} className="muted" />
  if (/\.(ts|tsx|js|jsx|py|go|rs|java|c|cpp|cs|rb|sh|json|ya?ml|toml|css|html|sql)$/i.test(name))
    return <FileCode size={14} className="muted" />
  return <FileIcon size={14} className="muted" />
}

function Preview(): JSX.Element {
  const fileContent = useStore((s) => s.fileContent)
  const selectedFile = useStore((s) => s.selectedFile)
  const fileMissing = useStore((s) => s.fileMissing)
  const editedAt = useStore((s) => (selectedFile ? (s.agentEdits[selectedFile] ?? 0) : 0))
  const flash = useEditFlash(editedAt)

  const bodyRef = useRef<HTMLDivElement>(null)
  const scrollRef = useRef(0)
  const prevPathRef = useRef<string | null>(null)

  /**
   * Preserve the reading position across a live reload. The content object is
   * replaced wholesale when the file changes on disk, which would otherwise snap
   * the view back to the top on every save — annoying when watching an agent work
   * through a long file. A genuine file switch resets to the top.
   */
  useLayoutEffect(() => {
    const el = bodyRef.current
    if (!el) return
    const samePathAsBefore = prevPathRef.current === (fileContent?.path ?? null)
    prevPathRef.current = fileContent?.path ?? null
    el.scrollTop = samePathAsBefore ? scrollRef.current : 0
  }, [fileContent])

  return (
    <div className="pane">
      <div className={`pane-header ${flash ? 'agent-edited' : ''}`}>
        <Eye size={14} className="copper" />
        <span className="preview-header">
          {selectedFile ? `Preview — ${selectedFile.split('/').pop()}` : 'Preview'}
        </span>
        {flash && <span className="edit-chip">agent edited</span>}
      </div>
      {fileMissing && (
        <div className="file-missing">
          <AlertTriangle size={12} />
          This file was deleted on disk. Showing the last version read.
        </div>
      )}
      <div
        className="preview-body"
        ref={bodyRef}
        onScroll={() => {
          if (bodyRef.current) scrollRef.current = bodyRef.current.scrollTop
        }}
      >
        {!fileContent ? (
          <div className="empty" style={{ height: '100%' }}>
            <span className="muted">Select a file to preview</span>
          </div>
        ) : fileContent.kind === 'markdown' ? (
          <MarkdownView source={fileContent.content} />
        ) : fileContent.kind === 'spreadsheet' ? (
          <SpreadsheetView sheets={fileContent.sheets ?? []} />
        ) : fileContent.kind === 'code' ? (
          <CodeView
            code={fileContent.content}
            language={fileContent.language}
            path={fileContent.path}
          />
        ) : (
          <div className="empty" style={{ height: '100%' }}>
            <span className="muted">Binary file — no preview</span>
          </div>
        )}
        {fileContent?.truncated && (
          <div className="muted" style={{ padding: '8px 16px', fontSize: 11 }}>
            ⚠ File truncated for preview.
          </div>
        )}
      </div>
    </div>
  )
}
