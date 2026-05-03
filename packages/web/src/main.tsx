import React from 'react';
import ReactDOM from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import { App } from './App';
import { startPendingMessageOrchestrator } from './stores/pendingMessageRehydrate';
import './styles/globals.css';

class ErrorBoundary extends React.Component<
  { children: React.ReactNode },
  { hasError: boolean; error: Error | null; showStack: boolean }
> {
  constructor(props: { children: React.ReactNode }) {
    super(props);
    this.state = { hasError: false, error: null, showStack: false };
  }

  static getDerivedStateFromError(error: Error) {
    return { hasError: true, error };
  }

  componentDidCatch(error: Error, errorInfo: React.ErrorInfo) {
    console.error('[ErrorBoundary]', error, errorInfo.componentStack);
    // Renderer is alive enough to show the fallback UI — disarm the boot timer.
    // Without this, the timer fires 20s after a caught render error and
    // overrides the in-app error UI with native recovery, which is wrong.
    if (typeof window.backspace?.rendererReady === 'function') {
      window.backspace.rendererReady();
    }
  }

  render() {
    if (this.state.hasError) {
      return (
        <div style={{
          height: '100vh',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          backgroundColor: '#0b0b10',
          color: '#efefef',
          fontFamily: "'DM Sans', sans-serif",
          flexDirection: 'column',
          gap: '16px',
          padding: '24px',
        }}>
          <h1 style={{ fontSize: '24px', fontWeight: 'bold' }}>Something went wrong</h1>
          <p style={{ color: '#a0a0aa', maxWidth: '480px', textAlign: 'center' }}>{this.state.error?.message}</p>
          <div style={{ display: 'flex', gap: '12px' }}>
            <button
              onClick={() => this.setState({ hasError: false, error: null })}
              style={{
                padding: '8px 24px',
                backgroundColor: '#7c6cf6',
                color: 'white',
                border: 'none',
                borderRadius: '8px',
                cursor: 'pointer',
                fontSize: '14px',
                fontFamily: "'DM Sans', sans-serif",
              }}
            >
              Try Again
            </button>
            <button
              onClick={() => window.location.reload()}
              style={{
                padding: '8px 24px',
                backgroundColor: 'transparent',
                color: '#a0a0aa',
                border: '1px solid rgba(255,255,255,0.1)',
                borderRadius: '8px',
                cursor: 'pointer',
                fontSize: '14px',
                fontFamily: "'DM Sans', sans-serif",
              }}
            >
              Reload Page
            </button>
          </div>
          {this.state.error?.stack && (
            <details
              open={this.state.showStack}
              onToggle={(e) => this.setState({ showStack: (e.target as HTMLDetailsElement).open })}
              style={{ maxWidth: '600px', width: '100%', marginTop: '8px' }}
            >
              <summary style={{ color: '#a0a0aa', cursor: 'pointer', fontSize: '13px' }}>
                Error details
              </summary>
              <pre style={{
                marginTop: '8px',
                padding: '12px',
                backgroundColor: 'rgba(255,255,255,0.05)',
                borderRadius: '8px',
                fontSize: '11px',
                color: '#a0a0aa',
                overflow: 'auto',
                maxHeight: '200px',
                whiteSpace: 'pre-wrap',
                wordBreak: 'break-word',
              }}>
                {this.state.error.stack}
              </pre>
            </details>
          )}
        </div>
      );
    }
    return this.props.children;
  }
}

const root = document.getElementById('root');
if (!root) throw new Error('Root element not found');

startPendingMessageOrchestrator();

ReactDOM.createRoot(root).render(
  <React.StrictMode>
    <ErrorBoundary>
      <BrowserRouter>
        <App />
      </BrowserRouter>
    </ErrorBoundary>
  </React.StrictMode>
);
