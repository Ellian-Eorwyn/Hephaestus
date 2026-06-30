import { Plus, Sun, Moon, PanelsTopLeft, Settings } from 'lucide-react'
import { useStore } from '../store/store'

export function TopNav(): JSX.Element {
  const harnesses = useStore((s) => s.harnesses)
  const view = useStore((s) => s.view)
  const theme = useStore((s) => s.theme)
  const setView = useStore((s) => s.setView)
  const toggleTheme = useStore((s) => s.toggleTheme)
  const toggleZen = useStore((s) => s.toggleZen)
  const setAddModal = useStore((s) => s.setAddModal)

  const activeId = view === 'dashboard' ? null : view.harnessId

  return (
    <header className="topnav">
      <span className="brand">Hephaestus</span>
      <nav className="nav-tabs">
        <button
          className={`nav-tab ${view === 'dashboard' ? 'active' : ''}`}
          onClick={() => setView('dashboard')}
        >
          Dashboard
        </button>
        {harnesses.map((h) => (
          <button
            key={h.id}
            className={`nav-tab ${activeId === h.id ? 'active' : ''}`}
            onClick={() => setView({ harnessId: h.id })}
          >
            {h.label}
          </button>
        ))}
        <button className="nav-add" title="Register harness" onClick={() => setAddModal(true)}>
          <Plus size={16} />
        </button>
      </nav>
      <div className="nav-right">
        <button className="icon-btn" title="Zen mode" onClick={toggleZen}>
          <PanelsTopLeft size={17} />
        </button>
        <button className="icon-btn" title="Toggle theme" onClick={toggleTheme}>
          {theme === 'dark' ? <Sun size={17} /> : <Moon size={17} />}
        </button>
        <button className="icon-btn" title="Settings" onClick={() => useStore.getState().setSettingsModalOpen(true)}>
          <Settings size={17} />
        </button>
      </div>
    </header>
  )
}
