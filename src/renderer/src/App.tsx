import { useEffect } from 'react'
import { Panel, PanelGroup, PanelResizeHandle } from 'react-resizable-panels'
import { useStore } from './store/store'
import { TopNav } from './components/TopNav'
import { StatusBar } from './components/StatusBar'
import { Projects } from './components/Projects'
import { Forge } from './components/Forge'
import { Inspector } from './components/Inspector'
import { Dashboard } from './components/Dashboard'
import { AddHarnessModal } from './components/AddHarnessModal'
import { SettingsModal } from './components/SettingsModal'

export function App(): JSX.Element {
  const init = useStore((s) => s.init)
  const view = useStore((s) => s.view)
  const zen = useStore((s) => s.zen)
  const addModalOpen = useStore((s) => s.addModalOpen)
  const inspectorDock = useStore((s) => s.inspectorDock)

  useEffect(() => {
    void init()
  }, [init])

  return (
    <div className="app">
      <TopNav />
      <div className="workspace">
        {view === 'dashboard' ? (
          <Dashboard />
        ) : inspectorDock === 'bottom' ? (
          /* ── Bottom dock: vertical split → top row (Projects + Forge) | bottom (Inspector) ── */
          <PanelGroup direction="vertical" autoSaveId="heph-rows">
            <Panel defaultSize={65} minSize={25} order={1}>
              <PanelGroup direction="horizontal" autoSaveId="heph-cols-top">
                {!zen && (
                  <>
                    <Panel defaultSize={20} minSize={12} order={1}>
                      <Projects />
                    </Panel>
                    <PanelResizeHandle className="rrp-handle" />
                  </>
                )}
                <Panel defaultSize={80} minSize={30} order={2}>
                  <Forge />
                </Panel>
              </PanelGroup>
            </Panel>
            <PanelResizeHandle className="rrp-handle" />
            <Panel defaultSize={35} minSize={12} order={2}>
              <Inspector dock="bottom" />
            </Panel>
          </PanelGroup>
        ) : (
          /* ── Right dock (default): single horizontal split ── */
          <PanelGroup direction="horizontal" autoSaveId="heph-cols">
            {!zen && (
              <>
                <Panel defaultSize={20} minSize={12} order={1}>
                  <Projects />
                </Panel>
                <PanelResizeHandle className="rrp-handle" />
              </>
            )}
            <Panel defaultSize={50} minSize={25} order={2}>
              <Forge />
            </Panel>
            <PanelResizeHandle className="rrp-handle" />
            <Panel defaultSize={30} minSize={18} order={3}>
              <Inspector dock="right" />
            </Panel>
          </PanelGroup>
        )}
      </div>
      <StatusBar />
      {addModalOpen && <AddHarnessModal />}
      <SettingsModal />
    </div>
  )
}

