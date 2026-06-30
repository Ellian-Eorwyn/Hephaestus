import { X } from 'lucide-react'
import { useStore } from '../store/store'

export function SettingsModal(): JSX.Element | null {
  const open = useStore((s) => s.settingsModalOpen)
  const setOpen = useStore((s) => s.setSettingsModalOpen)
  const messageSpacing = useStore((s) => s.messageSpacing)
  const showThinking = useStore((s) => s.showThinking)
  const showTools = useStore((s) => s.showTools)
  const showToolResults = useStore((s) => s.showToolResults)
  const updateSettings = useStore((s) => s.updateSettings)

  if (!open) return null

  return (
    <div className="modal-backdrop" onClick={() => setOpen(false)}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16 }}>
          <h3 style={{ margin: 0 }}>Settings</h3>
          <button className="icon-btn" onClick={() => setOpen(false)}>
            <X size={18} />
          </button>
        </div>

        <div className="field">
          <label className="label-tech">Message Spacing</label>
          <select
            value={messageSpacing}
            onChange={(e) => updateSettings({ messageSpacing: e.target.value as any })}
            style={{ padding: '6px 8px', borderRadius: 6, background: 'var(--bg-1)', color: 'var(--text-0)', border: '1px solid var(--border)', fontFamily: 'var(--font-mono)' }}
          >
            <option value="compact">Compact</option>
            <option value="cozy">Cozy</option>
            <option value="comfortable">Comfortable</option>
          </select>
        </div>

        <div className="field" style={{ marginTop: 12 }}>
          <label style={{ display: 'flex', alignItems: 'center', gap: 8, cursor: 'pointer', color: 'var(--text-1)' }}>
            <input
              type="checkbox"
              checked={showThinking}
              onChange={(e) => updateSettings({ showThinking: e.target.checked })}
            />
            Show Model Thinking
          </label>
        </div>

        <div className="field" style={{ marginTop: 12 }}>
          <label style={{ display: 'flex', alignItems: 'center', gap: 8, cursor: 'pointer', color: 'var(--text-1)' }}>
            <input
              type="checkbox"
              checked={showTools}
              onChange={(e) => updateSettings({ showTools: e.target.checked })}
            />
            Show Tool Calls (Bash, Read/Write, etc.)
          </label>
        </div>

        <div className="field" style={{ marginTop: 12 }}>
          <label style={{ display: 'flex', alignItems: 'center', gap: 8, cursor: 'pointer', color: 'var(--text-1)' }}>
            <input
              type="checkbox"
              checked={showToolResults}
              onChange={(e) => updateSettings({ showToolResults: e.target.checked })}
            />
            Show Tool Results
          </label>
        </div>

        <div className="modal-actions" style={{ marginTop: 20 }}>
          <button className="btn primary" onClick={() => setOpen(false)}>
            Done
          </button>
        </div>
      </div>
    </div>
  )
}
