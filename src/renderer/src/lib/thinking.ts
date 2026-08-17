import type { ThinkingLevel } from '@shared/types'

/**
 * Canonical thinking-level order. `xhigh` is model-gated (only some families
 * offer it) so the default Shift+Tab ring stops at `high`; when a live run knows
 * its model's supported set, `nextThinkingLevel` widens the ring to include it.
 */
export const THINKING_ORDER: ThinkingLevel[] = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh']

/** The ring cycled by Shift+Tab before a model's real capabilities are known. */
export const THINKING_CYCLE: ThinkingLevel[] = ['off', 'minimal', 'low', 'medium', 'high']

/** Shown until the app learns the harness's actual level (pi's own code default). */
export const DEFAULT_THINKING_LEVEL: ThinkingLevel = 'medium'

export const THINKING_LABEL: Record<ThinkingLevel, string> = {
  off: 'Off',
  minimal: 'Minimal',
  low: 'Low',
  medium: 'Medium',
  high: 'High',
  xhigh: 'X-High'
}

function ringFor(supported?: ThinkingLevel[]): ThinkingLevel[] {
  if (supported && supported.length) {
    const ring = THINKING_ORDER.filter((l) => supported.includes(l))
    if (ring.length) return ring
  }
  return THINKING_CYCLE
}

/** Next level in the cycle (wraps). `supported` restricts the ring to a model's levels. */
export function nextThinkingLevel(cur: ThinkingLevel, supported?: ThinkingLevel[]): ThinkingLevel {
  const ring = ringFor(supported)
  const i = ring.indexOf(cur)
  return ring[(i + 1) % ring.length] ?? ring[0]
}
