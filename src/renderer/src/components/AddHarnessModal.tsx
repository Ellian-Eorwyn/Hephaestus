import { useState } from 'react'
import { useStore } from '../store/store'

export function AddHarnessModal(): JSX.Element {
  const setAddModal = useStore((s) => s.setAddModal)
  const addHarness = useStore((s) => s.addHarness)
  const [label, setLabel] = useState('')
  const [agentDir, setAgentDir] = useState('')
  const [busy, setBusy] = useState(false)

  const submit = async () => {
    if (!label.trim() || !agentDir.trim()) return
    setBusy(true)
    try {
      await addHarness({ label: label.trim(), agentDir: agentDir.trim() })
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="modal-backdrop" onClick={() => setAddModal(false)}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <h3>Register Harness</h3>
        <div className="field">
          <label className="label-tech">Label</label>
          <input value={label} placeholder="e.g. Research" onChange={(e) => setLabel(e.target.value)} autoFocus />
        </div>
        <div className="field">
          <label className="label-tech">Agent directory</label>
          <input
            value={agentDir}
            placeholder="~/.my-harness/agent"
            onChange={(e) => setAgentDir(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && void submit()}
          />
          <div className="muted" style={{ fontSize: 10.5, marginTop: 6 }}>
            Path to a pi/forge-style <code>agent/</code> dir containing <code>sessions/</code> and{' '}
            <code>models.json</code>.
          </div>
        </div>
        <div className="modal-actions">
          <button className="btn" onClick={() => setAddModal(false)}>
            Cancel
          </button>
          <button className="btn primary" disabled={busy} onClick={() => void submit()}>
            {busy ? 'Adding…' : 'Register'}
          </button>
        </div>
      </div>
    </div>
  )
}
