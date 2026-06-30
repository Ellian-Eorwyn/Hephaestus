import type { BackendHealth, ModelsConfig } from '@shared/types'

/**
 * Best-effort health check of a harness's model backend. Pings the
 * OpenAI-compatible `<baseUrl>/models` endpoint. Failure => offline; never
 * throws to the caller. Note: `llms` may be a docker-internal hostname that
 * does not resolve from the host, in which case this reports offline.
 */
export async function checkBackend(harnessId: string, models: ModelsConfig | null): Promise<BackendHealth> {
  const checkedAt = new Date().toISOString()
  const provider = models ? Object.values(models.providers)[0] : undefined
  const baseUrl = provider?.baseUrl ?? ''
  if (!baseUrl) {
    return { harnessId, baseUrl, online: false, models: [], error: 'no baseUrl', checkedAt }
  }

  const url = baseUrl.replace(/\/$/, '') + '/models'
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), 2500)
  try {
    const res = await fetch(url, {
      signal: controller.signal,
      headers: provider?.apiKey ? { Authorization: `Bearer ${provider.apiKey}` } : undefined
    })
    clearTimeout(timeout)
    if (!res.ok) {
      return { harnessId, baseUrl, online: false, models: [], error: `HTTP ${res.status}`, checkedAt }
    }
    const body = (await res.json()) as { data?: { id: string }[] }
    const ids = (body.data ?? []).map((m) => m.id)
    return { harnessId, baseUrl, online: true, models: ids, checkedAt }
  } catch (err) {
    clearTimeout(timeout)
    return {
      harnessId,
      baseUrl,
      online: false,
      models: [],
      error: err instanceof Error ? err.message : 'unreachable',
      checkedAt
    }
  }
}
