import { useState, useCallback, useRef, useEffect } from 'react'
import { ChevronUp, ChevronDown } from 'lucide-react'
import { ICON } from '../lib/icons'
import type { SheetData } from '@shared/types'

/** Convert a 0-based column index to a spreadsheet letter (A, B, …, AA). */
function colLabel(i: number): string {
  let s = ''
  let n = i
  do {
    s = String.fromCharCode(65 + (n % 26)) + s
    n = Math.floor(n / 26) - 1
  } while (n >= 0)
  return s
}

type SortDir = 'asc' | 'desc' | null

interface SortState {
  col: number
  dir: SortDir
}

/**
 * Natural-order comparator: numbers sort numerically, everything else
 * lexicographically (case-insensitive). Empty cells sort last.
 */
function naturalCompare(a: string, b: string, dir: 'asc' | 'desc'): number {
  if (a === '' && b === '') return 0
  if (a === '') return 1
  if (b === '') return -1
  const na = Number(a)
  const nb = Number(b)
  const bothNum = !isNaN(na) && a !== '' && !isNaN(nb) && b !== ''
  const cmp = bothNum ? na - nb : a.localeCompare(b, undefined, { sensitivity: 'base' })
  return dir === 'asc' ? cmp : -cmp
}

/** Default minimum column width (px). */
const MIN_COL_W = 50
/** Default starting column width (px). */
const DEFAULT_COL_W = 140

export function SpreadsheetView({ sheets }: { sheets: SheetData[] }): JSX.Element {
  const [active, setActive] = useState(0)
  const sheet = sheets[active] ?? sheets[0]

  if (!sheet || sheet.rows.length === 0) {
    return (
      <div className="empty" style={{ height: '100%' }}>
        <span className="muted">Empty spreadsheet</span>
      </div>
    )
  }

  return (
    <div className="sheetview">
      {sheets.length > 1 && (
        <div className="sheet-tabs">
          {sheets.map((s, i) => (
            <button
              key={s.name + i}
              className={`sheet-tab ${i === active ? 'active' : ''}`}
              onClick={() => setActive(i)}
            >
              {s.name}
            </button>
          ))}
        </div>
      )}
      <SheetTable sheet={sheet} />
      {sheet.clipped && (
        <div className="muted" style={{ padding: '8px 14px', fontSize: 11 }}>
          ⚠ Large sheet — clipped for preview.
        </div>
      )}
    </div>
  )
}

/**
 * The actual sortable, resizable table. Separated from SpreadsheetView so that
 * sort / resize state resets cleanly when switching sheets.
 */
function SheetTable({ sheet }: { sheet: SheetData }): JSX.Element {
  const colCount = sheet.rows.reduce((m, r) => Math.max(m, r.length), 0)
  const [header, ...body] = sheet.rows

  // ---- Sorting ----
  const [sort, setSort] = useState<SortState>({ col: -1, dir: null })

  const handleSort = (col: number) => {
    setSort((prev) => {
      if (prev.col !== col) return { col, dir: 'asc' }
      if (prev.dir === 'asc') return { col, dir: 'desc' }
      return { col: -1, dir: null } // third click removes sort
    })
  }

  const sortedBody =
    sort.dir && sort.col >= 0
      ? [...body].sort((a, b) => naturalCompare(a[sort.col] ?? '', b[sort.col] ?? '', sort.dir!))
      : body

  // ---- Column resizing ----
  const [colWidths, setColWidths] = useState<number[]>(() =>
    Array.from({ length: colCount }, () => DEFAULT_COL_W)
  )
  const dragCol = useRef<number>(-1)
  const dragStartX = useRef(0)
  const dragStartW = useRef(0)

  const onResizeStart = useCallback(
    (e: React.MouseEvent, col: number) => {
      e.preventDefault()
      e.stopPropagation()
      dragCol.current = col
      dragStartX.current = e.clientX
      dragStartW.current = colWidths[col] ?? DEFAULT_COL_W

      const onMove = (ev: MouseEvent) => {
        const delta = ev.clientX - dragStartX.current
        setColWidths((prev) => {
          const next = [...prev]
          next[dragCol.current] = Math.max(MIN_COL_W, dragStartW.current + delta)
          return next
        })
      }
      const onUp = () => {
        document.removeEventListener('mousemove', onMove)
        document.removeEventListener('mouseup', onUp)
      }
      document.addEventListener('mousemove', onMove)
      document.addEventListener('mouseup', onUp)
    },
    [colWidths]
  )

  // Reset widths when column count changes (e.g. switching sheets)
  useEffect(() => {
    setColWidths(Array.from({ length: colCount }, () => DEFAULT_COL_W))
    setSort({ col: -1, dir: null })
  }, [colCount])

  return (
    <div className="sheet-scroll">
      <table className="sheet-table" style={{ tableLayout: 'fixed' }}>
        <colgroup>
          <col style={{ width: 42 }} />
          {Array.from({ length: colCount }, (_, c) => (
            <col key={c} style={{ width: colWidths[c] ?? DEFAULT_COL_W }} />
          ))}
        </colgroup>
        <thead>
          <tr>
            <th className="sheet-corner" />
            {Array.from({ length: colCount }, (_, c) => (
              <th key={c} className="sheet-collabel">
                {colLabel(c)}
              </th>
            ))}
          </tr>
          <tr>
            <th className="sheet-rownum">1</th>
            {Array.from({ length: colCount }, (_, c) => (
              <th
                key={c}
                className={`sheet-headcell sortable ${sort.col === c ? 'sorted' : ''}`}
                onClick={() => handleSort(c)}
                title={`Sort by ${header[c] ?? colLabel(c)}`}
              >
                <span className="sheet-head-text">{header[c] ?? ''}</span>
                {sort.col === c && sort.dir === 'asc' && <ChevronUp size={ICON.xs} className="sort-icon" />}
                {sort.col === c && sort.dir === 'desc' && <ChevronDown size={ICON.xs} className="sort-icon" />}
                <span
                  className="col-resize-handle"
                  onMouseDown={(e) => onResizeStart(e, c)}
                />
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {sortedBody.map((row, r) => (
            <tr key={r}>
              <td className="sheet-rownum">{r + 2}</td>
              {Array.from({ length: colCount }, (_, c) => (
                <td key={c} className="sheet-cell">
                  {row[c] ?? ''}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}
