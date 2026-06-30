/**
 * Themed activity indicator: a hammer that rests raised in the air, swings down
 * to strike the anvil — throwing a burst of sparks on impact — then drifts back
 * up and strikes again. Animated entirely with CSS keyframes (see `.forge-anvil`
 * in forge-folio.css) — no JS loop. Under `prefers-reduced-motion` it falls back
 * to a gentle glow pulse.
 *
 * Geometry note: the hammer group pivots about the top-right of the handle
 * (22, 6.5). Positive rotation lifts the head into the air; negative rotation
 * drives it down onto the anvil face.
 */
import hammerImg from '../assets/hammer.png'
import anvilImg from '../assets/anvil.png'

export function ForgeAnvil({ size = 26 }: { size?: number }): JSX.Element {
  return (
    <svg
      className="forge-anvil"
      width={size}
      height={size}
      viewBox="0 0 32 32"
      role="img"
      aria-label="Working"
      fill="none"
    >
      {/* Anvil */}
      <g className="anvil">
        <image href={anvilImg} x="-2" y="10" width="28" height="23" />
      </g>

      {/* Hammer — head (left) on a handle running up-right to the pivot */}
      <g className="hammer">
        <image href={hammerImg} x="5" y="-8" width="22" height="22" />
      </g>

      {/* Spark burst — keyed to fire only at the impact frame, over the strike point */}
      <g className="sparks" stroke="red" strokeWidth="1.8" strokeLinecap="round">
        <line x1="12" y1="16" x2="8" y2="10" />
        <line x1="12" y1="16" x2="13" y2="9" />
        <line x1="12" y1="16" x2="17" y2="11.5" />
        <circle cx="7.5" cy="9.5" r="1.2" fill="red" stroke="none" />
        <circle cx="16.5" cy="10.5" r="1.2" fill="red" stroke="none" />
      </g>
    </svg>
  )
}
