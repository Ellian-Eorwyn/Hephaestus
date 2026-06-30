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

  useEffect(() => {
    void init()
  }, [init])

  return (
    <div className="app">
      <TopNav />
      <div className="workspace">
        {view === 'dashboard' ? (
          <Dashboard />
        ) : (
          <PanelGroup direction="horizontal" autoSaveId="heph-cols">
            {!zen && (
              <>
                <Panel defaultSize={20} minSize={12} order={1}>
                  <Projects />
                </Panel>
                <PanelResizeHandle className="rrp-handle" />
              </>
            )}
            <Panel defaultSize={zen ? 50 : 50} minSize={25} order={2}>
              <Forge />
            </Panel>
            <PanelResizeHandle className="rrp-handle" />
            <Panel defaultSize={30} minSize={18} order={3}>
              <Inspector />
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
