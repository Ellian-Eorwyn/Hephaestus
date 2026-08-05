import { useEffect, useState } from 'react'
import { X } from 'lucide-react'
import { ICON } from '../lib/icons'
import { useStore, selectKnownPaths } from '../store/store'

export function SettingsModal(): JSX.Element | null {
  const open = useStore((s) => s.settingsModalOpen)
  const setOpen = useStore((s) => s.setSettingsModalOpen)
  const theme = useStore((s) => s.theme)
  const setTheme = useStore((s) => s.setTheme)
  const messageSpacing = useStore((s) => s.messageSpacing)
  const showThinking = useStore((s) => s.showThinking)
  const showTools = useStore((s) => s.showTools)
  const showToolResults = useStore((s) => s.showToolResults)
  const autoAttachFile = useStore((s) => s.autoAttachFile)
  const fileLinkGuidance = useStore((s) => s.fileLinkGuidance)
  const reduceMotion = useStore((s) => s.reduceMotion)
  const updateSettings = useStore((s) => s.updateSettings)

  if (!open) return null

  return (
    <div className="modal-backdrop" onClick={() => setOpen(false)}>
      <div className="modal settings-modal" onClick={(e) => e.stopPropagation()}>
        <header className="settings-head">
          <h3>Settings</h3>
          <button className="icon-btn" title="Close" onClick={() => setOpen(false)}>
            <X size={ICON.lg} />
          </button>
        </header>

        <div className="settings-body">
          <section className="settings-group">
            <div className="settings-group-title">Appearance</div>

            <SettingRow label="Theme">
              <Segmented
                value={theme}
                onChange={(v) => setTheme(v as 'dark' | 'light')}
                options={[
                  { value: 'dark', label: 'Dark' },
                  { value: 'light', label: 'Light' }
                ]}
              />
            </SettingRow>

            <SettingRow label="Message spacing">
              <select
                value={messageSpacing}
                onChange={(e) => updateSettings({ messageSpacing: e.target.value as 'compact' | 'cozy' | 'comfortable' })}
              >
                <option value="compact">Compact</option>
                <option value="cozy">Cozy</option>
                <option value="comfortable">Comfortable</option>
              </select>
            </SettingRow>

            <SettingRow label="Reduce motion" desc="Stop the forge hammer animation">
              <Toggle on={reduceMotion} onChange={(v) => updateSettings({ reduceMotion: v })} />
            </SettingRow>
          </section>

          <section className="settings-group">
            <div className="settings-group-title">Conversation</div>

            <SettingRow label="Show model thinking" desc="Reasoning shown in a collapsible lane">
              <Toggle on={showThinking} onChange={(v) => updateSettings({ showThinking: v })} />
            </SettingRow>

            <SettingRow label="Show tool calls" desc="Bash, Read/Write, and other tool invocations">
              <Toggle on={showTools} onChange={(v) => updateSettings({ showTools: v })} />
            </SettingRow>

            <SettingRow label="Show tool results" desc="Output returned by each tool">
              <Toggle on={showToolResults} onChange={(v) => updateSettings({ showToolResults: v })} />
            </SettingRow>
          </section>

          <section className="settings-group">
            <div className="settings-group-title">Behavior</div>

            <SettingRow
              label="Auto-attach viewed file"
              desc="Reference the open file in new prompts by default"
            >
              <Toggle on={autoAttachFile} onChange={(v) => updateSettings({ autoAttachFile: v })} />
            </SettingRow>

            <SettingRow
              label="Ask for clickable file paths"
              desc="Adds a short note to each prompt so files the agent names open in the preview. Costs a few tokens per message."
            >
              <Toggle
                on={fileLinkGuidance}
                onChange={(v) => updateSettings({ fileLinkGuidance: v })}
              />
            </SettingRow>
          </section>

          <StackSettings />

          <About />
        </div>

        <div className="modal-actions">
          <button className="btn primary" onClick={() => setOpen(false)}>
            Done
          </button>
        </div>
      </div>
    </div>
  )
}

/**
 * The port llm-stack-manager serves its state API on. Only ever used to *suggest*
 * a URL derived from the harness's own backend host — never assumed.
 */
const STACK_API_PORT = 8078

/**
 * Live monitoring of the machine behind the model backend.
 *
 * Off by default and blank on a fresh install: this reads an API that only exists
 * if you run llm-stack-manager, so it must cost nothing to everyone else. The URL
 * field is seeded from the harness's own provider host so the common case is a
 * single toggle rather than typing a hostname.
 */
function StackSettings(): JSX.Element {
  const config = useStore((s) => s.stackConfig)
  const harnesses = useStore((s) => s.harnesses)
  const save = useStore((s) => s.saveStackConfig)

  const [url, setUrl] = useState('')
  const [token, setToken] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [probe, setProbe] = useState<string | null>(null)
  const [probing, setProbing] = useState(false)

  // Adopt whatever main has stored, once it arrives.
  useEffect(() => {
    if (config) setUrl(config.baseUrl)
  }, [config?.baseUrl])

  // Nothing stored yet: guess from the harness backend's host. `models.json` points
  // at e.g. http://llms:8008/v1, and the state API sits on the same box.
  useEffect(() => {
    if (!config || config.baseUrl || !harnesses[0]) return
    let cancelled = false
    void window.heph
      .getModels(harnesses[0].id)
      .then((models) => {
        if (cancelled || !models) return
        const baseUrl = Object.values(models.providers)[0]?.baseUrl
        if (!baseUrl) return
        const host = new URL(baseUrl).hostname
        setUrl((current) => current || `http://${host}:${STACK_API_PORT}`)
      })
      .catch(() => {})
    return () => {
      cancelled = true
    }
  }, [config?.baseUrl, harnesses])

  if (!config) return <></>

  async function commit(next: { enabled?: boolean; baseUrl?: string; token?: string | null }) {
    setError(null)
    setProbe(null)
    try {
      await save({
        enabled: next.enabled ?? config!.enabled,
        baseUrl: next.baseUrl ?? url,
        token: next.token
      })
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not save')
    }
  }

  async function test() {
    setProbing(true)
    setProbe(null)
    // Deliberately tests what's typed, not what's saved, so a URL can be checked
    // before committing to it.
    const result = await window.heph.probeStack({ baseUrl: url, token: token || undefined })
    setProbing(false)
    setProbe(result.ok ? '✓ reachable' : `✗ ${result.error ?? 'unreachable'}`)
  }

  return (
    <section className="settings-group">
      <div className="settings-group-title">LLM stack</div>

      <SettingRow
        label="Monitor LLM stack"
        desc="Shows GPU load, VRAM and temperature from llm-stack-manager in the status bar"
      >
        <Toggle on={config.enabled} onChange={(v) => void commit({ enabled: v })} />
      </SettingRow>

      <SettingRow label="Stack API URL" desc="Host serving /api/v1">
        <input
          className="set-input"
          type="text"
          value={url}
          placeholder="http://host:8078"
          spellCheck={false}
          onChange={(e) => setUrl(e.target.value)}
          onBlur={() => url !== config.baseUrl && void commit({ baseUrl: url })}
          onKeyDown={(e) => e.key === 'Enter' && void commit({ baseUrl: url })}
        />
      </SettingRow>

      <SettingRow
        label="API token"
        desc="Optional. Unset, anything that can reach the port can read full stack state."
      >
        <div className="set-inline">
          <input
            className="set-input short"
            type="password"
            value={token}
            placeholder={config.hasToken ? '••••••• stored' : 'none'}
            spellCheck={false}
            onChange={(e) => setToken(e.target.value)}
            // Blank means "leave what's stored alone" — otherwise the field, which
            // renders empty after saving, would wipe the token on every blur.
            onBlur={() => token && void commit({ token }).then(() => setToken(''))}
          />
          {config.hasToken && (
            <button className="btn" onClick={() => void commit({ token: null })}>
              Clear
            </button>
          )}
        </div>
      </SettingRow>

      <SettingRow label="Test connection" desc={probe ?? error ?? 'Pings /api/v1/health'}>
        <button className="btn" disabled={probing || !url} onClick={() => void test()}>
          {probing ? 'Testing…' : 'Test'}
        </button>
      </SettingRow>
    </section>
  )
}

/**
 * Which build is running, and whether it can recognise file references.
 *
 * The version is here because "is the fix in the copy I'm running?" was otherwise
 * unanswerable from inside the app. The index count sits beside it because it is the
 * single thing that decides whether a path the agent names becomes a link: with
 * nothing indexed there is nothing to check a reference against, and every path
 * stays plain text however well the resolver works.
 */
function About(): JSX.Element {
  const { app, electron, chrome } = window.heph.versions
  const selectedCwd = useStore((s) => s.selectedCwd)
  const { known } = useStore(selectKnownPaths)

  return (
    <section className="settings-group">
      <div className="settings-group-title">About</div>
      <div className="settings-about">
        <div>
          Hephaestus <strong>{app}</strong>
        </div>
        <div className="muted">Electron {electron} · Chromium {chrome.split('.')[0]}</div>
        <div className="muted">
          {!selectedCwd
            ? 'No project open — file links need one.'
            : known.size === 0
              ? 'No files indexed yet for this project — file links stay plain text until it finishes.'
              : `${known.size.toLocaleString()} files indexed for file links.`}
        </div>
      </div>
    </section>
  )
}

function SettingRow({
  label,
  desc,
  children
}: {
  label: string
  desc?: string
  children: React.ReactNode
}): JSX.Element {
  return (
    <div className="set-row">
      <div className="set-label">
        <span>{label}</span>
        {desc && <span className="set-desc">{desc}</span>}
      </div>
      <div className="set-control">{children}</div>
    </div>
  )
}

function Toggle({ on, onChange }: { on: boolean; onChange: (v: boolean) => void }): JSX.Element {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={on}
      className={`switch ${on ? 'on' : ''}`}
      onClick={() => onChange(!on)}
    >
      <span className="knob" />
    </button>
  )
}

function Segmented({
  value,
  options,
  onChange
}: {
  value: string
  options: { value: string; label: string }[]
  onChange: (v: string) => void
}): JSX.Element {
  return (
    <div className="segmented">
      {options.map((o) => (
        <button
          key={o.value}
          type="button"
          className={value === o.value ? 'active' : ''}
          onClick={() => onChange(o.value)}
        >
          {o.label}
        </button>
      ))}
    </div>
  )
}
