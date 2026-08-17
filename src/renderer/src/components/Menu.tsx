import { useCallback, useEffect, useRef, useState } from 'react'
import type { KeyboardEvent, ReactNode } from 'react'

/** One row in a {@link Menu}. `hint` is right-aligned (e.g. a shortcut); `description` sits under the label. */
export interface MenuItem {
  id: string
  label: string
  hint?: string
  description?: string
  disabled?: boolean
}

/**
 * Headless roving-selection keyboard logic — the single source of truth shared by
 * every menu surface (the extension dialogs, the model / thinking pickers, and the
 * slash autocomplete). `onKeyDown` returns whether it consumed the event, so a host
 * textarea in "slaved" mode knows to `preventDefault` and skip its own handling.
 */
export function useRovingMenu(
  count: number,
  opts: { onChoose: (index: number) => void; onCancel?: () => void; loop?: boolean; initialIndex?: number }
): {
  activeIndex: number
  setActiveIndex: (i: number) => void
  onKeyDown: (e: KeyboardEvent) => boolean
} {
  const { onChoose, onCancel, loop = true, initialIndex = 0 } = opts
  const [activeIndex, setActiveIndex] = useState(initialIndex)

  // Keep the index in range as the item count changes (e.g. autocomplete filtering).
  useEffect(() => {
    setActiveIndex((i) => (count === 0 ? 0 : Math.min(i, count - 1)))
  }, [count])

  const onKeyDown = useCallback(
    (e: KeyboardEvent): boolean => {
      switch (e.key) {
        case 'ArrowDown':
          e.preventDefault()
          setActiveIndex((i) => (count ? (loop ? (i + 1) % count : Math.min(i + 1, count - 1)) : 0))
          return true
        case 'ArrowUp':
          e.preventDefault()
          setActiveIndex((i) => (count ? (loop ? (i - 1 + count) % count : Math.max(i - 1, 0)) : 0))
          return true
        case 'Home':
          e.preventDefault()
          setActiveIndex(0)
          return true
        case 'End':
          e.preventDefault()
          setActiveIndex(count ? count - 1 : 0)
          return true
        case 'Enter':
        case 'Tab':
          if (count === 0) return false
          e.preventDefault()
          onChoose(activeIndex)
          return true
        case 'Escape':
          e.preventDefault()
          e.stopPropagation()
          onCancel?.()
          return true
        default:
          return false
      }
    },
    [count, loop, activeIndex, onChoose, onCancel]
  )

  return { activeIndex, setActiveIndex, onKeyDown }
}

export interface MenuProps {
  items: MenuItem[]
  onChoose: (item: MenuItem, index: number) => void
  onCancel?: () => void
  /** `inline` sits in a thread card; `popover` floats above the composer. */
  variant?: 'inline' | 'popover'
  /** Focused mode: the list grabs focus and owns the keyboard (dialogs, click-opened pickers). */
  autoFocus?: boolean
  loop?: boolean
  /** Uncontrolled starting selection (e.g. a picker opening on the current value). */
  initialIndex?: number
  emptyLabel?: string
  header?: ReactNode
  ariaLabel?: string
  // Controlled ("slaved") mode — the host owns navigation and passes the active row.
  activeIndex?: number
  onActiveIndexChange?: (i: number) => void
}

/**
 * A keyboard-navigable list. In focused mode it captures focus (restoring it on
 * unmount) and handles arrows / Enter / Escape itself; in controlled mode the host
 * (the composer) drives navigation via {@link useRovingMenu} and this only renders.
 */
export function Menu({
  items,
  onChoose,
  onCancel,
  variant = 'inline',
  autoFocus = false,
  loop = true,
  initialIndex = 0,
  emptyLabel,
  header,
  ariaLabel,
  activeIndex: controlled,
  onActiveIndexChange
}: MenuProps): JSX.Element {
  const controlledMode = controlled !== undefined
  const rootRef = useRef<HTMLDivElement>(null)
  const restoreRef = useRef<Element | null>(null)

  const roving = useRovingMenu(items.length, {
    onChoose: (i) => {
      const it = items[i]
      if (it && !it.disabled) onChoose(it, i)
    },
    onCancel,
    loop,
    initialIndex
  })
  const activeIndex = controlledMode ? (controlled as number) : roving.activeIndex
  const setActive = (i: number): void => {
    if (controlledMode) onActiveIndexChange?.(i)
    else roving.setActiveIndex(i)
  }

  // Focused mode: grab focus, and restore it to whatever had it (the composer) on
  // unmount so dismissing a dialog returns the cursor where it was.
  useEffect(() => {
    if (!autoFocus) return
    restoreRef.current = document.activeElement
    rootRef.current?.focus()
    return () => {
      ;(restoreRef.current as HTMLElement | null)?.focus?.()
    }
  }, [autoFocus])

  // Keep the active row in view as it moves.
  useEffect(() => {
    rootRef.current
      ?.querySelector<HTMLElement>(`[data-idx="${activeIndex}"]`)
      ?.scrollIntoView({ block: 'nearest' })
  }, [activeIndex])

  return (
    <div
      ref={rootRef}
      className={`menu ${variant}`}
      role="listbox"
      aria-label={ariaLabel}
      aria-activedescendant={items.length ? `menu-item-${activeIndex}` : undefined}
      tabIndex={autoFocus ? -1 : undefined}
      onKeyDown={autoFocus && !controlledMode ? (e) => void roving.onKeyDown(e) : undefined}
    >
      {header}
      {items.length === 0 && emptyLabel ? <div className="menu-empty">{emptyLabel}</div> : null}
      {items.map((it, i) => (
        <div
          key={it.id}
          id={`menu-item-${i}`}
          data-idx={i}
          role="option"
          aria-selected={i === activeIndex}
          className={`menu-item${i === activeIndex ? ' active' : ''}${it.disabled ? ' disabled' : ''}`}
          onMouseEnter={() => setActive(i)}
          // Keep focus on the owner (textarea in slaved mode / the list in focused
          // mode) instead of letting the click steal it before onClick fires.
          onMouseDown={(e) => e.preventDefault()}
          onClick={() => {
            if (!it.disabled) onChoose(it, i)
          }}
        >
          <span className="menu-item-label">{it.label}</span>
          {it.hint ? <span className="menu-item-hint">{it.hint}</span> : null}
          {it.description ? <span className="menu-item-desc">{it.description}</span> : null}
        </div>
      ))}
    </div>
  )
}
