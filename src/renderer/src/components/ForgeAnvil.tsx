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
      <g className="anvil" fill="var(--text-2)">
        {/* face + horn */}
        <path d="M7 17 H22 L25 18.5 L22 20 H7 Z" />
        {/* neck */}
        <rect x="11" y="20" width="6" height="3" />
        {/* base */}
        <path d="M7 26 H21 L18.5 23 H9.5 Z" />
      </g>

      {/* Spark burst — keyed to fire only at the impact frame, over the strike point */}
      <g className="sparks" stroke="var(--ember)" strokeWidth="1.1" strokeLinecap="round">
        <line x1="12" y1="16" x2="9" y2="11.5" />
        <line x1="12" y1="16" x2="12.5" y2="10.5" />
        <line x1="12" y1="16" x2="16" y2="12.5" />
        <circle cx="8.5" cy="11" r="0.7" fill="var(--copper-bright)" stroke="none" />
        <circle cx="15.5" cy="11.5" r="0.7" fill="var(--gold)" stroke="none" />
      </g>

      {/* Hammer — head (left) on a handle running up-right to the pivot */}
      <g className="hammer">
        {/* handle */}
        <rect x="12.5" y="4.9" width="10.5" height="1.7" rx="0.85" fill="var(--copper-dim)" />
        {/* head */}
        <rect x="5.5" y="3" width="8.2" height="5" rx="1.3" fill="var(--copper)" />
        {/* striking face */}
        <rect x="5.5" y="6.2" width="8.2" height="1.8" rx="0.9" fill="var(--copper-dim)" />
        {/* highlight on the poll */}
        <rect x="11.4" y="3" width="2.3" height="5" rx="1.1" fill="var(--copper-bright)" />
      </g>
    </svg>
  )
}
