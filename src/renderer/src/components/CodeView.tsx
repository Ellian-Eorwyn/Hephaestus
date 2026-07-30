import { useEffect, useState } from 'react'
import { getHighlighter, normalizeLang, DARK_THEME, LIGHT_THEME } from '../lib/highlighter'
import { useStore } from '../store/store'

interface Line {
  tokens: { content: string; color?: string }[]
}

/**
 * Above this size, skip syntax highlighting. Shiki tokenizes on the main thread,
 * and a live-updating large file would re-tokenize on every save.
 */
const MAX_HIGHLIGHT_BYTES = 300_000

export function CodeView({
  code,
  language,
  path
}: {
  code: string
  language?: string
  path?: string
}): JSX.Element {
  const theme = useStore((s) => s.theme)
  const [lines, setLines] = useState<Line[] | null>(null)

  // Switching files must drop the previous file's tokens, which would otherwise
  // stay on screen for a frame. A *content* change deliberately keeps them, so a
  // live reload re-highlights in place instead of flashing "Rendering…".
  useEffect(() => {
    setLines(null)
  }, [path])

  useEffect(() => {
    let cancelled = false
    if (code.length > MAX_HIGHLIGHT_BYTES) {
      setLines(code.split('\n').map((l) => ({ tokens: [{ content: l }] })))
      return
    }
    const lang = normalizeLang(language)
    getHighlighter()
      .then((hl) => {
        if (cancelled) return
        try {
          const { tokens } = hl.codeToTokens(code, {
            lang: lang as never,
            theme: theme === 'dark' ? DARK_THEME : LIGHT_THEME
          })
          setLines(tokens.map((line) => ({ tokens: line.map((t) => ({ content: t.content, color: t.color })) })))
        } catch {
          // Unknown lang at runtime: render as plain lines.
          setLines(code.split('\n').map((l) => ({ tokens: [{ content: l }] })))
        }
      })
      .catch(() => {
        if (!cancelled) setLines(code.split('\n').map((l) => ({ tokens: [{ content: l }] })))
      })
    return () => {
      cancelled = true
    }
  }, [code, language, theme])

  if (!lines) {
    return <div className="codeview" style={{ padding: 16, color: 'var(--text-faint)' }}>Rendering…</div>
  }

  return (
    <div className="codeview">
      <table>
        <tbody>
          {lines.map((line, i) => (
            <tr key={i}>
              <td className="ln">{i + 1}</td>
              <td className="lc">
                <pre>
                  {line.tokens.length === 0 ? (
                    ' '
                  ) : (
                    line.tokens.map((t, j) => (
                      <span key={j} style={t.color ? { color: t.color } : undefined}>
                        {t.content}
                      </span>
                    ))
                  )}
                </pre>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}
