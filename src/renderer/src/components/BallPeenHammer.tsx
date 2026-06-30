/**
 * Ball-peen hammer icon — a clean, artisanal silhouette rendered as a single
 * SVG path in `currentColor` with a thin dark outline.  No surrounding box or
 * gradient background; it sits inline like a typography glyph.
 *
 * The shape: a short cylindrical head with a flat striking face on one side and
 * a rounded ball peen on the other, mounted on a slightly angled handle.
 */
import hammerImg from '../assets/hammer.png'

export function BallPeenHammer({
  size = 16,
  className
}: {
  size?: number
  className?: string
}): JSX.Element {
  return (
    <img
      src={hammerImg}
      width={size}
      height={size}
      className={className}
      alt="Hammer"
      style={{ display: 'inline-block', verticalAlign: 'middle', objectFit: 'contain' }}
    />
  )
}
