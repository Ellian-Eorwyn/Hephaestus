/**
 * The one icon scale.
 *
 * Sizes used to be chosen ad hoc at each call site (11, 12, 13, 14, 15, 16, 18, 26,
 * 28), so glyphs sitting next to each other in the same row disagreed by a pixel or
 * two for no reason. Pick from here instead.
 *
 * Note that a size passed to a lucide icon becomes `width`/`height` *attributes*, so
 * CSS `font-size` has no effect on one — a size must be passed explicitly.
 */
export const ICON = {
  /** Inline with small mono text: chevrons, chips, badges. */
  xs: 12,
  /** Default for list rows: the file tree, the session list, tool blocks. */
  sm: 14,
  /** Pane headers, buttons, avatars' inner glyph. */
  md: 16,
  /** Emphasis: composer send, harness crest. */
  lg: 20,
  /** Empty-state and drop-zone glyphs. */
  xl: 28,
  /** The single large glyph in a full-pane empty state. */
  hero: 46
} as const

/**
 * Glyph size inside the 30px `.msg .avatar` slot. Both avatar states use it, so the
 * avatar no longer changes size when a turn starts and finishes.
 */
export const AVATAR_GLYPH = 22
