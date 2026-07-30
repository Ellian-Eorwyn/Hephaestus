import { promises as fs } from 'node:fs'
import path from 'node:path'
import type {
  SessionRecord,
  ThreadMessage,
  SessionDetail,
  SessionSummary,
  UsageTotals,
  Usage,
  RawMessage
} from '@shared/types'
import { parseViewingContext } from '@shared/viewing-context'

/**
 * Decode a sessions/ folder name back to its working directory.
 *
 * The harness encodes a cwd by replacing path separators with `-` and wrapping
 * in `--…--`. Because real path segments can themselves contain `-`, this is
 * lossy and not perfectly reversible. We do a best-effort decode: strip the
 * leading/trailing `--`, then turn the remaining single `-` separators back into
 * `/`. The first segment is empty (absolute path), giving a leading slash.
 */
export function decodeCwd(encoded: string): string {
  let s = encoded
  if (s.startsWith('--')) s = s.slice(2)
  if (s.endsWith('--')) s = s.slice(0, -2)
  // `--Users-username--` -> `Users-username` -> `/Users/username`
  // Segments that were originally separated by `/` are now separated by `-`.
  // We cannot distinguish them from in-name hyphens, so reconstruct a plausible
  // POSIX path and let downstream existence checks confirm.
  return '/' + s.split('-').join('/')
}

/**
 * Encode a working directory path into the folder name format used under
 * `sessions/`. This is the inverse of `decodeCwd`: strip leading `/`,
 * replace `/` with `-`, wrap in `--…--`.
 */
export function encodeCwd(cwd: string): string {
  // Normalise: resolve trailing slashes, collapse double slashes.
  const normalised = path.resolve(cwd)
  // Strip the leading `/`, replace remaining `/` with `-`, wrap in `--…--`.
  const inner = normalised.replace(/^\//, '').replace(/\//g, '-')
  return `--${inner}--`
}

/**
 * Parse newline-delimited JSON records out of a text chunk. Tolerant of malformed
 * lines: the harness appends while we read, so a torn trailing line is normal and
 * simply skipped — the next read picks it up complete.
 */
export function parseRecords(text: string): SessionRecord[] {
  const records: SessionRecord[] = []
  for (const line of text.split('\n')) {
    const trimmed = line.trim()
    if (!trimmed) continue
    try {
      records.push(JSON.parse(trimmed) as SessionRecord)
    } catch {
      // skip malformed line
    }
  }
  return records
}

/** Parse a .jsonl session file into raw records. */
export async function readRecords(filePath: string): Promise<SessionRecord[]> {
  return parseRecords(await fs.readFile(filePath, 'utf8'))
}

/**
 * Resolve the leaf thread from the id/parentId tree. Records form a tree; the
 * "live" conversation is the path from the root to the most recent leaf. We
 * pick the leaf as the last message-bearing record, then walk parentId up.
 */
function resolveLeafThread(records: SessionRecord[]): SessionRecord[] {
  const byId = new Map<string, SessionRecord>()
  for (const r of records) if (r.id) byId.set(r.id, r)

  // Choose the leaf: the last record in file order that has an id.
  let leaf: SessionRecord | undefined
  for (let i = records.length - 1; i >= 0; i--) {
    if (records[i].id) {
      leaf = records[i]
      break
    }
  }
  if (!leaf) return records

  const chain: SessionRecord[] = []
  let cur: SessionRecord | undefined = leaf
  const seen = new Set<string>()
  while (cur) {
    if (cur.id && seen.has(cur.id)) break
    if (cur.id) seen.add(cur.id)
    chain.push(cur)
    const pid: string | null | undefined = cur.parentId
    cur = pid ? byId.get(pid) : undefined
  }
  return chain.reverse()
}

function blockText(message: RawMessage): {
  text: string
  thinking: string
  toolCalls: NonNullable<ThreadMessage['toolCalls']>
} {
  let text = ''
  let thinking = ''
  const toolCalls: NonNullable<ThreadMessage['toolCalls']> = []
  for (const block of message.content ?? []) {
    if (block.type === 'text' && typeof (block as { text?: string }).text === 'string') {
      text += (block as { text: string }).text
    } else if (block.type === 'thinking') {
      thinking += (block as { thinking?: string }).thinking ?? ''
    } else if (block.type === 'toolCall') {
      const tc = block as { id: string; name: string; arguments: unknown }
      toolCalls.push({ id: tc.id, name: tc.name, arguments: tc.arguments })
    }
  }
  return { text, thinking, toolCalls }
}

/**
 * Convert raw records into normalized UI messages.
 *
 * `idPrefix` seeds the fallback id for records the harness wrote without one.
 * It must be stable across re-parses of the same file: these ids become React
 * keys, so a fresh random id per parse would unmount and re-render the row (and
 * re-parse its markdown, and jump the scroll position) on every watcher tick.
 */
export function toThread(records: SessionRecord[], idPrefix = 'rec'): ThreadMessage[] {
  const thread = resolveLeafThread(records)
  const messages: ThreadMessage[] = []
  let index = 0
  // Timestamp (ms) and id of the previous record in the thread, used to estimate
  // the response time of each assistant turn for the tokens/sec stat.
  let prevTs: number | null = null
  let prevId: string | undefined
  for (const r of thread) {
    const curTs = r.timestamp ? Date.parse(r.timestamp) : NaN
    if (r.type !== 'message' || !r.message) {
      if (!Number.isNaN(curTs)) prevTs = curTs
      prevId = r.id ?? prevId
      continue
    }
    const fallbackId = `${idPrefix}#${index++}`
    const m = r.message
    if (m.role === 'toolResult') {
      const text = (m.content ?? [])
        .map((b) => (b.type === 'text' ? (b as { text: string }).text : ''))
        .join('')
      messages.push({
        id: r.id ?? fallbackId,
        role: 'toolResult',
        timestamp: r.timestamp,
        toolResult: { toolCallId: m.toolCallId, toolName: m.toolName, isError: m.isError, text }
      })
      if (!Number.isNaN(curTs)) prevTs = curTs
      prevId = r.id ?? prevId
      continue
    }
    const { text, thinking, toolCalls } = blockText(m)
    // Strip any injected "currently-viewing" context from user messages so the
    // chat shows only what the user typed, surfacing it as an attachment instead.
    let displayText = text
    let attachedFile: string | undefined
    if (m.role === 'user' && text) {
      const parsed = parseViewingContext(text)
      displayText = parsed.text
      attachedFile = parsed.file
    }

    // Per-turn stats: effective output tokens/sec = output ÷ response time, where
    // response time is from the prior record to this assistant message.
    //
    // Only meaningful when the previous record is this message's direct parent.
    // Otherwise the gap spans something else entirely — a tool round-trip, or a
    // jump across a fork — and dividing by it reports a throughput the model never
    // achieved. This is always an estimate derived from record timestamps, so it's
    // labelled approximate in the UI; a live run replaces it with a measured (or
    // provider-reported) figure.
    let outputTokens: number | undefined
    let tps: number | undefined
    if (m.role === 'assistant') {
      outputTokens = m.usage?.output
      const adjacent = prevId !== undefined && r.parentId === prevId
      if (outputTokens && adjacent && prevTs != null && !Number.isNaN(curTs)) {
        const seconds = (curTs - prevTs) / 1000
        if (seconds > 0.05 && seconds < 3600) tps = outputTokens / seconds
      }
    }

    messages.push({
      id: r.id ?? fallbackId,
      role: m.role,
      timestamp: r.timestamp,
      text: displayText || undefined,
      thinking: thinking || undefined,
      toolCalls: toolCalls.length ? toolCalls : undefined,
      usage: m.usage,
      model: m.responseModel ?? m.model,
      attachedFile,
      outputTokens,
      tps,
      // Derived from record timestamps, never a reported figure.
      tpsApprox: tps === undefined ? undefined : true
    })
    if (!Number.isNaN(curTs)) prevTs = curTs
    prevId = r.id ?? prevId
  }
  return messages
}


const ZERO: UsageTotals = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: 0 }

/** Sum usage across all assistant messages in a thread. */
export function sumUsage(messages: ThreadMessage[]): UsageTotals {
  const t = { ...ZERO }
  for (const m of messages) {
    const u = m.usage
    if (!u) continue
    t.input += u.input ?? 0
    t.output += u.output ?? 0
    t.cacheRead += u.cacheRead ?? 0
    t.cacheWrite += u.cacheWrite ?? 0
    t.totalTokens += u.totalTokens ?? 0
    t.cost += u.cost?.total ?? 0
  }
  return t
}

/**
 * Estimate the "current context" size: the last assistant message reflects the
 * input it actually consumed plus the output it produced — a good proxy for how
 * full the context window is right now.
 */
export function currentContext(messages: ThreadMessage[]): number {
  for (let i = messages.length - 1; i >= 0; i--) {
    const u = messages[i].usage
    if (u) return (u.input ?? 0) + (u.output ?? 0) + (u.cacheRead ?? 0)
  }
  return 0
}

export interface BuildOptions {
  /** Map of modelId -> contextWindow from models.json, to fill the gauge. */
  contextWindowByModel?: Record<string, number>
  /** Fallback context window when the model can't be matched. */
  defaultContextWindow?: number | null
}

export async function buildSessionDetail(
  filePath: string,
  opts: BuildOptions = {}
): Promise<SessionDetail> {
  return buildSessionDetailFromRecords(filePath, await readRecords(filePath), opts)
}

/** The pure half of `buildSessionDetail`, for callers that already hold the records. */
export function buildSessionDetailFromRecords(
  filePath: string,
  records: SessionRecord[],
  opts: BuildOptions = {}
): SessionDetail {
  const header = records.find((r) => r.type === 'session') ?? { type: 'session' }
  // Derive the fallback-id prefix from the file so ids stay identical across
  // reloads of the same session (and can't collide between sessions).
  const messages = toThread(records, path.basename(filePath, '.jsonl'))
  const usage = sumUsage(messages)

  // Determine context window from the most recent assistant model.
  let contextWindow: number | null = opts.defaultContextWindow ?? null
  for (let i = messages.length - 1; i >= 0; i--) {
    const model = messages[i].model
    if (model && opts.contextWindowByModel?.[model]) {
      contextWindow = opts.contextWindowByModel[model]
      break
    }
  }

  return {
    path: filePath,
    header,
    messages,
    usage,
    contextWindow,
    currentContextTokens: currentContext(messages)
  }
}

/** Lightweight summary parse (header + first user message + totals) for listings. */
export async function summarize(filePath: string): Promise<SessionSummary> {
  return summarizeRecords(filePath, await readRecords(filePath))
}

const EMPTY_TITLE = '(empty session)'

/**
 * Running totals for a session summary. Every field is cumulative, so a caller
 * that already summarized the first N records can fold in only what was appended
 * instead of walking the whole session again on each change.
 */
export interface SummaryAccum {
  messageCount: number
  totalTokens: number
  title: string
}

export function newSummaryAccum(): SummaryAccum {
  return { messageCount: 0, totalTokens: 0, title: EMPTY_TITLE }
}

/** Fold one record into a running summary. */
export function foldSummaryRecord(acc: SummaryAccum, r: SessionRecord): void {
  if (r.type !== 'message' || !r.message) return
  acc.messageCount++
  const m = r.message
  if (m.usage?.totalTokens) acc.totalTokens += m.usage.totalTokens
  if (acc.title === EMPTY_TITLE && m.role === 'user') {
    const firstText = (m.content ?? []).find((b) => b.type === 'text') as
      | { text?: string }
      | undefined
    if (firstText?.text) acc.title = truncate(parseViewingContext(firstText.text).text, 80)
  }
}

export function summaryFromAccum(
  filePath: string,
  header: SessionRecord | undefined,
  acc: SummaryAccum
): SessionSummary {
  return {
    path: filePath,
    id: header?.id ?? path.basename(filePath).replace(/\.jsonl$/, ''),
    timestamp: header?.timestamp ?? '',
    title: acc.title,
    messageCount: acc.messageCount,
    totalTokens: acc.totalTokens,
    // The header carries the authoritative working directory (the folder name is a
    // lossy encoding that mangles real hyphens), so prefer it for the project cwd.
    cwd: header?.cwd ?? ''
  }
}

/** The pure half of `summarize`, for callers that already hold the records. */
export function summarizeRecords(filePath: string, records: SessionRecord[]): SessionSummary {
  const acc = newSummaryAccum()
  for (const r of records) foldSummaryRecord(acc, r)
  return summaryFromAccum(
    filePath,
    records.find((r) => r.type === 'session'),
    acc
  )
}

function truncate(s: string, n: number): string {
  const oneLine = s.replace(/\s+/g, ' ').trim()
  return oneLine.length > n ? oneLine.slice(0, n - 1) + '…' : oneLine
}

export type { Usage }
