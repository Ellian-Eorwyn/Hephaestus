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
