import { promises as fs } from 'node:fs'
import path from 'node:path'
import type {
  SessionRecord,
  ThreadMessage,
  SessionDetail,
  UsageTotals,
  Usage,
  RawMessage
} from '@shared/types'

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
  // `--Users-ellie--` -> `Users-ellie` -> `/Users/ellie`
  // Segments that were originally separated by `/` are now separated by `-`.
  // We cannot distinguish them from in-name hyphens, so reconstruct a plausible
  // POSIX path and let downstream existence checks confirm.
  return '/' + s.split('-').join('/')
}

/** Parse a .jsonl session file into raw records. Tolerant of malformed lines. */
export async function readRecords(filePath: string): Promise<SessionRecord[]> {
  const raw = await fs.readFile(filePath, 'utf8')
  const records: SessionRecord[] = []
  for (const line of raw.split('\n')) {
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

/** Convert raw records into normalized UI messages. */
export function toThread(records: SessionRecord[]): ThreadMessage[] {
  const thread = resolveLeafThread(records)
  const messages: ThreadMessage[] = []
  for (const r of thread) {
    if (r.type !== 'message' || !r.message) continue
    const m = r.message
    if (m.role === 'toolResult') {
      const text = (m.content ?? [])
        .map((b) => (b.type === 'text' ? (b as { text: string }).text : ''))
        .join('')
      messages.push({
        id: r.id ?? cryptoId(),
        role: 'toolResult',
        timestamp: r.timestamp,
        toolResult: { toolCallId: m.toolCallId, toolName: m.toolName, isError: m.isError, text }
      })
      continue
    }
    const { text, thinking, toolCalls } = blockText(m)
    messages.push({
      id: r.id ?? cryptoId(),
      role: m.role,
      timestamp: r.timestamp,
      text: text || undefined,
      thinking: thinking || undefined,
      toolCalls: toolCalls.length ? toolCalls : undefined,
      usage: m.usage,
      model: m.responseModel ?? m.model
    })
  }
  return messages
}

function cryptoId(): string {
  return Math.random().toString(36).slice(2, 10)
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

export async function buildSessionDetail(filePath: string, opts: BuildOptions = {}): Promise<SessionDetail> {
  const records = await readRecords(filePath)
  const header = records.find((r) => r.type === 'session') ?? { type: 'session' }
  const messages = toThread(records)
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
export async function summarize(filePath: string) {
  const records = await readRecords(filePath)
  const header = records.find((r) => r.type === 'session')
  const id = header?.id ?? path.basename(filePath).replace(/\.jsonl$/, '')
  const timestamp = header?.timestamp ?? ''
  // The header carries the authoritative working directory (the folder name is a
  // lossy encoding that mangles real hyphens), so prefer it for the project cwd.
  const cwd = header?.cwd ?? ''

  let title = '(empty session)'
  let messageCount = 0
  let totalTokens = 0
  for (const r of records) {
    if (r.type !== 'message' || !r.message) continue
    messageCount++
    const m = r.message
    if (m.usage?.totalTokens) totalTokens += m.usage.totalTokens
    if (title === '(empty session)' && m.role === 'user') {
      const firstText = (m.content ?? []).find((b) => b.type === 'text') as { text?: string } | undefined
      if (firstText?.text) title = truncate(firstText.text, 80)
    }
  }
  return { path: filePath, id, timestamp, title, messageCount, totalTokens, cwd }
}

function truncate(s: string, n: number): string {
  const oneLine = s.replace(/\s+/g, ' ').trim()
  return oneLine.length > n ? oneLine.slice(0, n - 1) + '…' : oneLine
}

export type { Usage }
