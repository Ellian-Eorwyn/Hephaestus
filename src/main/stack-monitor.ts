import { promises as fs } from 'node:fs'
import path from 'node:path'
import { app } from 'electron'
import type {
  StackAlert,
  StackConfig,
  StackConfigInput,
  StackGpu,
  StackProbeResult,
  StackStatus
} from '@shared/types'

/** How often to poll while the window has focus. */
const ACTIVE_INTERVAL_MS = 5_000
/** …and while it doesn't. The numbers are only worth anything to someone looking. */
const IDLE_INTERVAL_MS = 30_000
/** Same budget `checkBackend` gives a backend ping. */
const REQUEST_TIMEOUT_MS = 2_500

/**
 * The sections we ask for. The API also serves `backends`, `services`, `host`,
 * `config` and `deployment`, which together make the unfiltered response ~23 KB;
 * asking for only what's rendered brings it to ~3 KB. An older API that ignores
 * `include` just returns everything, which still parses.
 */
const SECTIONS = 'stack,gpus,alerts,router'

/** On-disk shape. Distinct from `StackConfig` because only this side holds the token. */
interface StoredConfig {
  enabled: boolean
  baseUrl: string
  token: string
}

const EMPTY: StoredConfig = { enabled: false, baseUrl: '', token: '' }

/**
 * Normalize a user-typed stack URL to a bare origin.
 *
 * The scheme allowlist is the security boundary, not a formality: this string is
 * typed by hand and then fetched, so anything but http(s) is refused outright
 * rather than handed to `fetch` to interpret. Path and query are dropped because
 * the endpoints are appended to whatever comes back.
 *
 * @throws if the input isn't a usable http(s) URL.
 */
export function normalizeBaseUrl(input: string): string {
  const trimmed = input.trim()
  if (!trimmed) throw new Error('Enter a URL')
  // Bare `host:port` is what people actually type; assume http rather than reject.
  const withScheme = /^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(trimmed) ? trimmed : `http://${trimmed}`
  let url: URL
  try {
    url = new URL(withScheme)
  } catch {
    throw new Error(`Not a valid URL: ${trimmed}`)
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error(`Only http and https are allowed (got ${url.protocol.replace(':', '')})`)
  }
  return url.origin
}

/** A number from an API that may have sent null/absent/garbage. */
function num(v: unknown): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : 0
}

function str(v: unknown): string | undefined {
  return typeof v === 'string' ? v : undefined
}

function bool(v: unknown): boolean {
  return v === true
}

/** Raw snapshot rows, named loosely — the API owns this shape, we only read it. */
type Row = Record<string, unknown>

function parseGpus(raw: unknown): StackGpu[] {
  if (!Array.isArray(raw)) return []
  return raw.map((g: Row, i) => ({
    index: typeof g.index === 'number' ? g.index : i,
    name: str(g.name) ?? 'GPU',
    memUsedMib: num(g.mem_used),
    memTotalMib: num(g.mem_total),
    memPct: num(g.mem_pct),
    util: num(g.util),
    temp: num(g.temp),
    powerWatts: num(g.power_watts),
    powerLimitWatts: num(g.power_limit_watts),
    fanPct: num(g.fan_pct),
    busy: bool(g.busy),
    // `models` carries what is actually resident; the alias is the name the user
    // recognises (`chat-dense`), where `model` is a long absolute .gguf path.
    models: Array.isArray(g.models)
      ? (g.models as Row[]).map((m) => str(m.model_alias) ?? str(m.unit) ?? '').filter(Boolean)
      : []
  }))
}

function parseAlerts(raw: unknown): StackAlert[] {
  if (!Array.isArray(raw)) return []
  return (raw as Row[]).map((a) => {
    const level = str(a.level)
    return {
      level: level === 'error' || level === 'warn' ? level : 'info',
      code: str(a.code) ?? '',
      subject: str(a.subject) ?? '',
      text: str(a.text) ?? ''
    }
  })
}

/**
 * Live view of the LLM stack behind the harnesses' model backend.
 *
 * Polls rather than using the API's SSE stream on purpose: `?include=` on
 * `/api/v1/events` filters event *types*, not sections, so its `snapshot` frames
 * stay ~23 KB every 2 s, and its `delta` frames only fire on state changes — not
 * on the GPU metrics this shows. A filtered snapshot poll is an order of
 * magnitude less traffic and needs no reconnect handling.
 */
export class StackMonitor {
  private configPath: string
  private config: StoredConfig = { ...EMPTY }
  private timer: NodeJS.Timeout | null = null
  private intervalMs = ACTIVE_INTERVAL_MS
  private last: StackStatus | null = null
  /** Guards against overlapping polls when the stack is slow to answer. */
  private inFlight = false
  /**
   * Bumped on every config change. A poll carries the generation it started
   * under, so a slow response from a URL we've since moved off can't publish
   * itself — otherwise pointing the monitor at a dead host would leave the old
   * host's numbers on screen, still looking live.
   */
  private generation = 0

  constructor(private emit: (status: StackStatus) => void) {
    this.configPath = path.join(app.getPath('userData'), 'stack.json')
  }

  async load(): Promise<StackConfig> {
    try {
      const raw = await fs.readFile(this.configPath, 'utf8')
      const parsed = JSON.parse(raw) as Partial<StoredConfig>
      this.config = {
        enabled: parsed.enabled === true,
        baseUrl: typeof parsed.baseUrl === 'string' ? parsed.baseUrl : '',
        token: typeof parsed.token === 'string' ? parsed.token : ''
      }
    } catch {
      // First run, or unreadable — the monitor stays off until it's configured.
      this.config = { ...EMPTY }
    }
    this.restart()
    return this.publicConfig()
  }

  publicConfig(): StackConfig {
    return {
      enabled: this.config.enabled,
      baseUrl: this.config.baseUrl,
      hasToken: this.config.token.length > 0
    }
  }

  /** The most recent poll, so a reloading renderer doesn't wait for the next tick. */
  lastStatus(): StackStatus | null {
    return this.last
  }

  async setConfig(input: StackConfigInput): Promise<StackConfig> {
    // An empty URL is only allowed while disabled — otherwise there is nothing to poll.
    const baseUrl = input.baseUrl.trim() ? normalizeBaseUrl(input.baseUrl) : ''
    if (input.enabled && !baseUrl) throw new Error('Enter a URL')

    this.config = {
      enabled: input.enabled,
      baseUrl,
      // `undefined` leaves the stored token alone (the field renders blank once
      // saved, so an untouched field must not wipe it); `null` or '' clears it.
      token: input.token === undefined ? this.config.token : (input.token ?? '')
    }
    await this.persist()
    this.restart()
    return this.publicConfig()
  }

  /** One-shot check against a URL that hasn't been saved, for the Settings button. */
  async probe(baseUrl: string, token?: string | null): Promise<StackProbeResult> {
    let origin: string
    try {
      origin = normalizeBaseUrl(baseUrl)
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : 'Invalid URL' }
    }
    // Fall back to the saved token so testing an unchanged config doesn't need it retyped.
    const auth = token === undefined || token === null ? this.config.token : token
    try {
      const res = await this.request(`${origin}/api/v1/health`, auth)
      if (!res.ok) return { ok: false, error: `HTTP ${res.status}` }
      const body = (await res.json()) as { ok?: boolean }
      return body.ok === false
        ? { ok: false, error: 'Stack reports it is not healthy' }
        : { ok: true }
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : 'unreachable' }
    }
  }

  /**
   * Focus follows the user: nobody reads a status bar in a background window, so
   * back off rather than keep hammering the stack at full rate.
   */
  setActive(active: boolean): void {
    const next = active ? ACTIVE_INTERVAL_MS : IDLE_INTERVAL_MS
    if (next === this.intervalMs) return
    this.intervalMs = next
    if (this.timer) this.restart()
  }

  dispose(): void {
    if (this.timer) clearInterval(this.timer)
    this.timer = null
  }

  private restart(): void {
    this.dispose()
    // Retire anything still in flight: its result belongs to the old config, so
    // it must neither be published nor hold up the first poll of the new one.
    this.generation++
    this.inFlight = false
    this.last = null
    if (!this.config.enabled || !this.config.baseUrl) return
    void this.poll()
    this.timer = setInterval(() => void this.poll(), this.intervalMs)
  }

  private async persist(): Promise<void> {
    try {
      await fs.writeFile(this.configPath, JSON.stringify(this.config, null, 2), 'utf8')
    } catch {
      // Non-fatal: the monitor still runs this session, it just won't be remembered.
    }
  }

  private request(url: string, token: string): Promise<Response> {
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS)
    return fetch(url, {
      signal: controller.signal,
      headers: token ? { Authorization: `Bearer ${token}` } : undefined
    }).finally(() => clearTimeout(timeout))
  }

  private async poll(): Promise<void> {
    if (this.inFlight) return
    const gen = this.generation
    const { baseUrl, token } = this.config
    this.inFlight = true
    try {
      const status = await this.fetchStatus(baseUrl, token)
      // The config moved while this was in the air — publishing now would
      // attribute one server's numbers to another.
      if (gen !== this.generation) return
      // Only wake the renderer when something actually moved. A stopped stack
      // otherwise republishes the same failure every interval, forever.
      if (!this.same(status, this.last)) this.emit(status)
      this.last = status
    } finally {
      // A newer generation has already reset this; don't clobber its poll.
      if (gen === this.generation) this.inFlight = false
    }
  }

  private async fetchStatus(baseUrl: string, token: string): Promise<StackStatus> {
    const checkedAt = new Date().toISOString()
    try {
      const res = await this.request(`${baseUrl}/api/v1/snapshot?include=${SECTIONS}`, token)
      if (!res.ok) {
        return { reachable: false, baseUrl, checkedAt, error: `HTTP ${res.status}`, gpus: [], alerts: [] }
      }
      const body = (await res.json()) as Row
      const stack = (body.stack ?? {}) as Row
      const router = (body.router ?? {}) as Row
      return {
        reachable: true,
        baseUrl,
        checkedAt,
        hostname: str(stack.hostname),
        busy: bool(stack.busy),
        servicesActive: num(stack.services_active),
        servicesTotal: num(stack.services_total),
        backendsActive: num(stack.backends_active),
        // `stack.router_enabled` is the configured intent; `router.reachable` is
        // whether it actually answered. Show the second when we have it.
        routerEnabled:
          typeof router.reachable === 'boolean' ? router.reachable : bool(stack.router_enabled),
        gpus: parseGpus(body.gpus),
        alerts: parseAlerts(body.alerts)
      }
    } catch (err) {
      return {
        reachable: false,
        baseUrl,
        checkedAt,
        error: err instanceof Error ? err.message : 'unreachable',
        gpus: [],
        alerts: []
      }
    }
  }

  /** Equality ignoring `checkedAt`, which changes on every single poll. */
  private same(a: StackStatus, b: StackStatus | null): boolean {
    if (!b) return false
    return JSON.stringify({ ...a, checkedAt: '' }) === JSON.stringify({ ...b, checkedAt: '' })
  }
}
