import { useState } from 'react'
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

  const colCount = sheet.rows.reduce((m, r) => Math.max(m, r.length), 0)
  const [header, ...body] = sheet.rows

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
      <div className="sheet-scroll">
        <table className="sheet-table">
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
                <th key={c} className="sheet-headcell">
                  {header[c] ?? ''}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {body.map((row, r) => (
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
      {sheet.clipped && (
        <div className="muted" style={{ padding: '8px 14px', fontSize: 11 }}>
          ⚠ Large sheet — clipped for preview.
        </div>
      )}
    </div>
  )
}
