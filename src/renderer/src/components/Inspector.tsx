import { useState } from 'react'
import { Panel, PanelGroup, PanelResizeHandle } from 'react-resizable-panels'
import {
  ChevronRight,
  ChevronDown,
  FileText,
  FileCode,
  File as FileIcon,
  Folder,
  FolderOpen,
  Files,
  Eye
} from 'lucide-react'
import { useStore } from '../store/store'
import { MarkdownView } from './MarkdownView'
import { CodeView } from './CodeView'
import type { FileNode } from '@shared/types'

export function Inspector(): JSX.Element {
  return (
    <div className="pane">
      <PanelGroup direction="vertical" autoSaveId="heph-inspector">
        <Panel defaultSize={42} minSize={15}>
          <FileBrowser />
        </Panel>
        <PanelResizeHandle className="rrp-handle" />
        <Panel defaultSize={58} minSize={20}>
          <Preview />
        </Panel>
      </PanelGroup>
    </div>
  )
}

function FileBrowser(): JSX.Element {
  const fileTree = useStore((s) => s.fileTree)
  const selectedCwd = useStore((s) => s.selectedCwd)

  return (
    <div className="pane">
      <div className="pane-header">
        <Files size={14} className="copper" />
        <span className="label-tech">Files</span>
        {selectedCwd && (
          <span className="muted" style={{ marginLeft: 'auto', fontSize: 10, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={selectedCwd}>
            {selectedCwd}
          </span>
        )}
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

function TreeNode({ node, depth }: { node: FileNode; depth: number }): JSX.Element {
  const [open, setOpen] = useState(depth < 1)
  const selectFile = useStore((s) => s.selectFile)
  const selectedFile = useStore((s) => s.selectedFile)

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
      className={`filenode ${selectedFile === node.path ? 'active' : ''}`}
      style={{ paddingLeft: 14 + depth * 14 + 18 }}
      onClick={() => void selectFile(node.path)}
    >
      <FileGlyph name={node.name} />
      <span>{node.name}</span>
    </div>
  )
}

function FileGlyph({ name }: { name: string }): JSX.Element {
  if (/\.(md|markdown|mdx)$/i.test(name)) return <FileText size={14} className="muted" />
  if (/\.(ts|tsx|js|jsx|py|go|rs|java|c|cpp|cs|rb|sh|json|ya?ml|toml|css|html|sql)$/i.test(name))
    return <FileCode size={14} className="muted" />
  return <FileIcon size={14} className="muted" />
}

function Preview(): JSX.Element {
  const fileContent = useStore((s) => s.fileContent)
  const selectedFile = useStore((s) => s.selectedFile)

  return (
    <div className="pane">
      <div className="pane-header">
        <Eye size={14} className="copper" />
        <span className="preview-header">
          {selectedFile ? `Preview — ${selectedFile.split('/').pop()}` : 'Preview'}
        </span>
      </div>
      <div className="preview-body">
        {!fileContent ? (
          <div className="empty" style={{ height: '100%' }}>
            <span className="muted">Select a file to preview</span>
          </div>
        ) : fileContent.kind === 'markdown' ? (
          <MarkdownView source={fileContent.content} />
        ) : fileContent.kind === 'code' ? (
          <CodeView code={fileContent.content} language={fileContent.language} />
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
