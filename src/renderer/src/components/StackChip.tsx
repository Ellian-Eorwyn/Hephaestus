import { useEffect, useRef } from 'react'
import { useShallow } from 'zustand/react/shallow'
import { AlertTriangle, Info, XCircle } from 'lucide-react'
import { ICON } from '../lib/icons'
import { useStore } from '../store/store'
import type { StackAlert, StackGpu } from '@shared/types'

/** MiB -> a short GB string. The API reports VRAM in MiB. */
function gb(mib: number): string {
  const value = mib / 1024
  return value >= 100 ? String(Math.round(value)) : value.toFixed(1)
}

/**
 * What the chip shows, reduced from however many GPUs are installed: VRAM summed,
 * load and heat taken from the worst offender. One busy card is the thing worth
 * knowing about, and an average would hide it.
 */
function summarize(gpus: StackGpu[]): {
  usedMib: number
  totalMib: number
  util: number
  temp: number
} {
  return {
    usedMib: gpus.reduce((n, g) => n + g.memUsedMib, 0),
    totalMib: gpus.reduce((n, g) => n + g.memTotalMib, 0),
    util: gpus.reduce((n, g) => Math.max(n, g.util), 0),
    temp: gpus.reduce((n, g) => Math.max(n, g.temp), 0)
  }
}

function worstLevel(alerts: StackAlert[]): 'error' | 'warn' | null {
  if (alerts.some((a) => a.level === 'error')) return 'error'
  if (alerts.some((a) => a.level === 'warn')) return 'warn'
  return null
}

/**
 * Live readout of the LLM stack behind the model backend.
 *
 * Renders nothing unless the monitor is switched on and has produced a reading,
 * so the status bar is untouched on machines without this backend.
 */
export function StackChip(): JSX.Element | null {
  const enabled = useStore((s) => s.stackConfig?.enabled ?? false)
  const open = useStore((s) => s.stackPanelOpen)
  const setOpen = useStore((s) => s.setStackPanelOpen)

  // Only the fields the chip paints, so unrelated store writes (and the parts of
  // the status that only the panel reads) don't re-render the bar.
  const chip = useStore(
    useShallow((s) => {
      const st = s.stack
      if (!st) return null
      const { usedMib, totalMib, util, temp } = summarize(st.gpus)
      return {
        reachable: st.reachable,
        hostname: st.hostname ?? 'STACK',
        level: worstLevel(st.alerts),
        usedMib,
        totalMib,
        util,
        temp
      }
    })
  )

  if (!enabled || !chip) return null

  const dot = !chip.reachable
    ? 'offline'
    : chip.level === 'error'
      ? 'error'
      : chip.level === 'warn'
        ? 'warn'
        : 'online'

  return (
    <>
      <button
        type="button"
        className={`stack-chip ${open ? 'open' : ''}`}
        aria-expanded={open}
        onClick={() => setOpen(!open)}
        title={chip.reachable ? 'LLM stack — click for detail' : 'LLM stack unreachable'}
      >
        <span className={`dot ${dot}`} />
        <span className="stack-host">{chip.hostname.toUpperCase()}</span>
        {chip.reachable && chip.totalMib > 0 && (
          <>
            <span>
              VRAM {gb(chip.usedMib)}/{gb(chip.totalMib)}G
            </span>
            <span>GPU {Math.round(chip.util)}%</span>
            <span>{Math.round(chip.temp)}°C</span>
          </>
        )}
        {!chip.reachable && <span>UNREACHABLE</span>}
      </button>
      {open && <StackPanel onClose={() => setOpen(false)} />}
    </>
  )
}

function StackPanel({ onClose }: { onClose: () => void }): JSX.Element | null {
  const stack = useStore((s) => s.stack)
  const ref = useRef<HTMLDivElement>(null)

  // Dismiss on Escape or a click anywhere else. The chip itself is excluded so
  // its own click toggles rather than closing and immediately reopening.
  useEffect(() => {
    function onKey(e: KeyboardEvent): void {
      if (e.key === 'Escape') onClose()
    }
    function onDown(e: MouseEvent): void {
      const target = e.target as Node
      if (ref.current?.contains(target)) return
      if ((target as HTMLElement).closest?.('.stack-chip')) return
      onClose()
    }
    document.addEventListener('keydown', onKey)
    document.addEventListener('mousedown', onDown)
    return () => {
      document.removeEventListener('keydown', onKey)
      document.removeEventListener('mousedown', onDown)
    }
  }, [onClose])

  if (!stack) return null

  return (
    <div className="stack-panel" ref={ref} role="dialog" aria-label="LLM stack">
      <div className="stack-panel-head">
        <span className="copper">{stack.hostname ?? 'LLM stack'}</span>
        <span className="muted">{stack.baseUrl}</span>
      </div>

      {!stack.reachable ? (
        <div className="stack-unreachable">{stack.error ?? 'Unreachable'}</div>
      ) : (
        <>
          {stack.gpus.map((g) => (
            <GpuRow key={g.index} gpu={g} />
          ))}
          {stack.gpus.length === 0 && <div className="muted">No GPUs reported.</div>}
          <div className="stack-facts">
            <span>
              services {stack.servicesActive ?? 0}/{stack.servicesTotal ?? 0}
            </span>
            <span>backends {stack.backendsActive ?? 0}</span>
            <span>router {stack.routerEnabled ? 'on' : 'off'}</span>
            {stack.busy && <span className="copper">busy</span>}
          </div>
        </>
      )}

      {stack.alerts.length > 0 && (
        <div className="stack-alerts">
          {stack.alerts.map((a, i) => (
            <div key={`${a.code}-${i}`} className={`stack-alert ${a.level}`}>
              {a.level === 'error' ? (
                <XCircle size={ICON.xs} />
              ) : a.level === 'warn' ? (
                <AlertTriangle size={ICON.xs} />
              ) : (
                <Info size={ICON.xs} />
              )}
              <span>{a.text}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

function GpuRow({ gpu }: { gpu: StackGpu }): JSX.Element {
  const pct = gpu.memTotalMib > 0 ? Math.min(100, (gpu.memUsedMib / gpu.memTotalMib) * 100) : 0
  return (
    <div className="stack-gpu">
      <div className="stack-gpu-top">
        <span className="stack-gpu-name" title={gpu.name}>
          GPU{gpu.index} {gpu.name.replace(/^NVIDIA GeForce /, '')}
        </span>
        {/* Same meter as the context gauge — a track with a copper fill. */}
        <span className="ctx-bar">
          <span style={{ width: `${pct}%` }} />
        </span>
        <span className="stack-gpu-mem">
          {gb(gpu.memUsedMib)}/{gb(gpu.memTotalMib)}G
        </span>
        <span className="stack-gpu-util">{Math.round(gpu.util)}%</span>
      </div>
      <div className="stack-gpu-sub muted">
        <span>{gpu.models.length > 0 ? gpu.models.join(' · ') : 'no model resident'}</span>
        <span>
          {Math.round(gpu.temp)}°C · {Math.round(gpu.powerWatts)}W
          {gpu.powerLimitWatts > 0 && `/${Math.round(gpu.powerLimitWatts)}W`}
        </span>
      </div>
    </div>
  )
}
