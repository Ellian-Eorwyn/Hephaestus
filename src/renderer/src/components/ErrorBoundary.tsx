import { Component, type ErrorInfo, type ReactNode } from 'react'

/**
 * Last line of defence for the renderer.
 *
 * A throw during render unmounts the whole tree, leaving a blank window that looks
 * exactly like a freeze — with no way to tell the two apart after the fact. Catching
 * it means the failure names itself and the app can be recovered with a reload
 * instead of a force-quit.
 */
export class ErrorBoundary extends Component<{ children: ReactNode }, { error: Error | null }> {
  state: { error: Error | null } = { error: null }

  static getDerivedStateFromError(error: Error): { error: Error } {
    return { error }
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    console.error('Renderer crashed:', error, info.componentStack)
  }

  render(): ReactNode {
    const { error } = this.state
    if (!error) return this.props.children
    return (
      <div className="crash-screen">
        <div>
          <h2>The forge cracked</h2>
          <p className="muted">Something in the interface threw and the view was torn down.</p>
          <pre className="crash-detail">{error.stack ?? error.message}</pre>
          <div className="crash-actions">
            <button className="btn primary" onClick={() => this.setState({ error: null })}>
              Try again
            </button>
            <button className="btn" onClick={() => window.location.reload()}>
              Reload
            </button>
          </div>
        </div>
      </div>
    )
  }
}
