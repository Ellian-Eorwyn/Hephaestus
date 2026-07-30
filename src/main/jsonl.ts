import { StringDecoder } from 'node:string_decoder'
import type { Readable } from 'node:stream'

/**
 * Line reader for the harness's JSONL stdout.
 *
 * This deliberately does NOT use `node:readline`. pi's RPC client contract
 * requires splitting on \n only, because U+2028/U+2029 are legal *inside* JSON
 * string values and a reader that treats them as line breaks tears an event into
 * unparseable halves. Current Node (checked: 20.18.3 as bundled by Electron 33,
 * and 22.x) no longer splits on them, so this is spec compliance rather than a
 * fix for observed loss here — but the contract is what's guaranteed, not the
 * current implementation detail of whatever runtime we happen to ship on. pi's
 * reference implementation lives at
 * `packages/coding-agent/src/modes/rpc/jsonl.ts`.
 *
 * A `StringDecoder` handles multi-byte characters straddling chunk boundaries,
 * which a naive `String(chunk)` would corrupt.
 *
 * Returns a detach function that removes the listeners.
 */
export function attachJsonlLineReader(
  stream: Readable,
  onLine: (line: string) => void
): () => void {
  const decoder = new StringDecoder('utf8')
  let buffer = ''

  const emit = (raw: string): void => {
    // Tolerate CRLF: strip a single trailing \r left behind by the \n split.
    const line = raw.endsWith('\r') ? raw.slice(0, -1) : raw
    if (line) onLine(line)
  }

  const onData = (chunk: Buffer | string): void => {
    buffer += typeof chunk === 'string' ? chunk : decoder.write(chunk)
    let nl = buffer.indexOf('\n')
    while (nl !== -1) {
      emit(buffer.slice(0, nl))
      buffer = buffer.slice(nl + 1)
      nl = buffer.indexOf('\n')
    }
  }

  const onEnd = (): void => {
    // Flush any bytes held by the decoder, then a final unterminated line. The
    // harness always newline-terminates, but a killed process can leave a
    // partial line we'd rather attempt than discard.
    buffer += decoder.end()
    if (buffer) {
      emit(buffer)
      buffer = ''
    }
  }

  stream.on('data', onData)
  stream.on('end', onEnd)

  return () => {
    stream.off('data', onData)
    stream.off('end', onEnd)
  }
}
