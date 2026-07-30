import { memo, useMemo } from 'react'
import { MarkdownBody } from './MarkdownView'

/**
 * Markdown for text that is still streaming.
 *
 * Rendering the whole accumulated reply on every frame means re-parsing it from
 * scratch each time, so the cost grows with the square of the reply length — a
 * long answer visibly stutters near the end. Instead the source is split into
 * top-level blocks and each block is memoized, so a frame only re-parses the
 * block currently being written. Earlier blocks keep their index and their exact
 * text, so their memo holds.
 */
export function StreamMarkdown({ source }: { source: string }): JSX.Element {
  const blocks = useMemo(() => splitBlocks(source), [source])
  return (
    <div className="markdown">
      {blocks.map((b, i) => (
        <Block key={i} text={b} />
      ))}
    </div>
  )
}

const Block = memo(function Block({ text }: { text: string }): JSX.Element {
  return <MarkdownBody source={text} />
})

const FENCE = /^ {0,3}(`{3,}|~{3,})/

/**
 * Split markdown on blank lines, but never inside a fenced code block — cutting a
 * fence in half would render the two halves as prose. Blank lines are kept so
 * spacing survives the round-trip, and trailing blanks attach to the block that
 * follows them (they carry no rendered output either way).
 *
 * Exported for tests.
 */
export function splitBlocks(source: string): string[] {
  if (!source) return ['']
  const blocks: string[] = []
  let current: string[] = []
  let fence: { char: string; len: number } | null = null

  const flush = (): void => {
    if (current.length) {
      blocks.push(current.join('\n'))
      current = []
    }
  }

  for (const line of source.split('\n')) {
    const m = FENCE.exec(line)
    if (m) {
      const marker = m[1]
      if (!fence) {
        fence = { char: marker[0], len: marker.length }
      } else if (
        marker[0] === fence.char &&
        marker.length >= fence.len &&
        line.slice(m[0].length).trim() === ''
      ) {
        // A closing fence must use the same character, be at least as long, and
        // carry nothing but whitespace after it.
        fence = null
      }
      current.push(line)
      continue
    }
    current.push(line)
    // A blank line outside a fence ends the block — but only once the block has
    // real content, so runs of blanks don't produce empty blocks.
    if (!fence && line.trim() === '' && current.some((l) => l.trim() !== '')) flush()
  }
  flush()
  return blocks.length ? blocks : ['']
}
