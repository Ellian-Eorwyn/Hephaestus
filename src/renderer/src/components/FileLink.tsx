import { useMemo } from 'react'
import { relativeTo } from '@shared/paths'
import { useStore, selectKnownPaths } from '../store/store'
import type { LinkContext } from '../lib/filelinks'
import { FileGlyph } from './Inspector'

/**
 * A file the agent referenced, rendered as something you can click: it expands the
 * tree down to that file, selects it, and shows it in the preview pane.
 *
 * A button rather than an anchor — there is no navigation here, and an `<a href>`
 * inside the chat would be handled by the same inert-link path as external URLs.
 */
export function FileLink({
  path,
  line,
  label,
  unverified,
  variant = 'inline'
}: {
  path: string
  line?: number
  /** Text to show; defaults to the project-relative path. */
  label?: string
  /**
   * The path sits inside the project but matches nothing we have listed. Still
   * clickable — it may be a file created moments ago — but drawn so it doesn't
   * promise more than it can deliver.
   */
  unverified?: boolean
  /**
   * `inline` sits in a sentence, `code` keeps the monospace look of the backticks
   * it replaced, `chip` is a standalone row (tool blocks).
   */
  variant?: 'inline' | 'code' | 'chip'
}): JSX.Element {
  const revealFile = useStore((s) => s.revealFile)
  const selectedCwd = useStore((s) => s.selectedCwd)
  const text = label ?? relativeTo(selectedCwd, path) + (line ? `:${line}` : '')
  const name = path.split('/').pop() ?? path
  const target = line ? `${path}:${line}` : path

  return (
    <button
      type="button"
      className={`file-link ${variant}${unverified ? ' unverified' : ''}`}
      title={unverified ? `${target}\nNot in the project index — it may not exist yet.` : target}
      onClick={(e) => {
        e.stopPropagation()
        e.preventDefault()
        void revealFile(path, line)
      }}
    >
      <FileGlyph name={name} size={12} />
      <span className="file-link-text">{text}</span>
    </button>
  )
}

/** The context every link resolver needs: project root, home dir, known paths. */
export function useLinkContext(): LinkContext {
  const cwd = useStore((s) => s.selectedCwd)
  const { known, byBasename } = useStore(selectKnownPaths)
  return useMemo(
    () => ({ cwd, home: window.heph.homeDir, known, byBasename }),
    [cwd, known, byBasename]
  )
}
