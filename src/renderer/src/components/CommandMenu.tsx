import { useEffect, useRef, useState } from 'react'
import {
  useStore,
  samePath,
  selectCurrentRunId,
  selectActiveModel,
  selectThinkingLevel
} from '../store/store'
import { Menu, type MenuItem } from './Menu'
import { THINKING_CYCLE, THINKING_LABEL } from '../lib/thinking'
import type { ForkPoint, ThinkingLevel } from '@shared/types'

const heph = window.heph

/**
 * The composer-anchored popover for the click / command-opened pickers (model,
 * thinking level, session, fork). The `slash` autocomplete is driven by the
 * composer itself, so it is ignored here. Each picker is a focused {@link Menu}
 * that owns the keyboard and restores focus to the composer when it closes.
 */
export function CommandMenu(): JSX.Element | null {
  const menu = useStore((s) => s.commandMenu)
  const close = useStore((s) => s.closeCommandMenu)
  const ref = useRef<HTMLDivElement>(null)

  // Dismiss on a click outside the popover (Escape is handled by the Menu itself).
  // The status-bar chips are excluded so their own click toggles rather than
  // closing and immediately reopening.
  useEffect(() => {
    if (!menu || menu.kind === 'slash') return
    function onDown(e: MouseEvent): void {
      const t = e.target as Node
      if (ref.current?.contains(t)) return
      if ((t as HTMLElement).closest?.('.sb-chip')) return
      close()
    }
    document.addEventListener('mousedown', onDown)
    return () => document.removeEventListener('mousedown', onDown)
  }, [menu, close])

  if (!menu || menu.kind === 'slash') return null

  return (
    <div ref={ref}>
      {menu.kind === 'model' && <ModelPicker />}
      {menu.kind === 'think' && <ThinkPicker />}
      {menu.kind === 'session' && <SessionPicker />}
      {menu.kind === 'fork' && <ForkPicker />}
    </div>
  )
}

function ModelPicker(): JSX.Element {
  const models = useStore((s) => s.availableModels)
  const active = useStore(selectActiveModel)
  const setModel = useStore((s) => s.setModel)
  const close = useStore((s) => s.closeCommandMenu)

  const items: MenuItem[] = models.map((m) => ({
    id: `${m.provider}/${m.modelId}`,
    label: m.label,
    description: m.provider,
    hint:
      active && active.provider === m.provider && active.modelId === m.modelId ? '● active' : undefined
  }))
  const initial = Math.max(
    0,
    models.findIndex((m) => active && m.provider === active.provider && m.modelId === active.modelId)
  )

  return (
    <Menu
      variant="popover"
      autoFocus
      ariaLabel="Select model"
      emptyLabel="No models available"
      initialIndex={initial}
      items={items}
      onChoose={(it) => {
        const m = models.find((x) => `${x.provider}/${x.modelId}` === it.id)
        if (m) void setModel(m.provider, m.modelId, m.label)
        close()
      }}
      onCancel={close}
    />
  )
}

function ThinkPicker(): JSX.Element {
  const level = useStore(selectThinkingLevel)
  const model = useStore(selectActiveModel)
  const setLevel = useStore((s) => s.setThinkingLevel)
  const close = useStore((s) => s.closeCommandMenu)

  const levels: ThinkingLevel[] = model?.thinkingLevels?.length ? model.thinkingLevels : THINKING_CYCLE
  const items: MenuItem[] = levels.map((l) => ({
    id: l,
    label: THINKING_LABEL[l],
    hint: l === level ? '● current' : undefined
  }))

  return (
    <Menu
      variant="popover"
      autoFocus
      ariaLabel="Thinking level"
      initialIndex={Math.max(0, levels.indexOf(level))}
      items={items}
      onChoose={(it) => {
        void setLevel(it.id as ThinkingLevel)
        close()
      }}
      onCancel={close}
    />
  )
}

function SessionPicker(): JSX.Element {
  const close = useStore((s) => s.closeCommandMenu)
  const selectSession = useStore((s) => s.selectSession)
  const harnessId = useStore((s) => (s.view === 'dashboard' ? null : s.view.harnessId))
  const project = useStore((s) => s.projects.find((p) => samePath(p.cwd, s.selectedCwd)))
  const sessions = project?.sessions ?? []

  const items: MenuItem[] = sessions.map((sess) => ({
    id: sess.path,
    label: sess.title || sess.id,
    description: `${sess.messageCount} msg${sess.messageCount === 1 ? '' : 's'}`
  }))

  return (
    <Menu
      variant="popover"
      autoFocus
      ariaLabel="Open session"
      emptyLabel="No past sessions in this project"
      items={items}
      onChoose={(it) => {
        const sess = sessions.find((x) => x.path === it.id)
        if (sess && harnessId && project) void selectSession(harnessId, sess.path, project.cwd)
        close()
      }}
      onCancel={close}
    />
  )
}

function ForkPicker(): JSX.Element {
  const close = useStore((s) => s.closeCommandMenu)
  const fork = useStore((s) => s.forkSession)
  const [forks, setForks] = useState<ForkPoint[]>([])
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    const runId = selectCurrentRunId(useStore.getState())
    if (!runId) {
      setLoading(false)
      return
    }
    let alive = true
    void heph
      .agentGetForkMessages(runId)
      .then((f) => {
        if (alive) {
          setForks(f)
          setLoading(false)
        }
      })
      .catch(() => {
        if (alive) setLoading(false)
      })
    return () => {
      alive = false
    }
  }, [])

  const items: MenuItem[] = forks.map((f) => ({
    id: f.entryId,
    label: f.text ? f.text.slice(0, 70) : f.entryId
  }))

  return (
    <Menu
      variant="popover"
      autoFocus
      ariaLabel="Fork from an earlier message"
      emptyLabel={loading ? 'Loading…' : 'No fork points'}
      items={items}
      onChoose={(it) => {
        void fork(it.id)
        close()
      }}
      onCancel={close}
    />
  )
}
