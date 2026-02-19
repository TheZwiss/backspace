import { jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
import React from 'react';
import ReactDOM from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import { App } from './App';
import './styles/globals.css';
class ErrorBoundary extends React.Component {
    constructor(props) {
        super(props);
        this.state = { hasError: false, error: null };
    }
    static getDerivedStateFromError(error) {
        return { hasError: true, error };
    }
    render() {
        if (this.state.hasError) {
            return (_jsxs("div", { style: {
                    height: '100vh',
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    backgroundColor: '#313338',
                    color: '#ffffff',
                    fontFamily: 'sans-serif',
                    flexDirection: 'column',
                    gap: '16px',
                }, children: [_jsx("h1", { style: { fontSize: '24px', fontWeight: 'bold' }, children: "Something went wrong" }), _jsx("p", { style: { color: '#abacb2' }, children: this.state.error?.message }), _jsx("button", { onClick: () => window.location.reload(), style: {
                            padding: '8px 24px',
                            backgroundColor: '#5865f2',
                            color: 'white',
                            border: 'none',
                            borderRadius: '4px',
                            cursor: 'pointer',
                            fontSize: '14px',
                        }, children: "Reload" })] }));
        }
        return this.props.children;
    }
}
const root = document.getElementById('root');
if (!root)
    throw new Error('Root element not found');
ReactDOM.createRoot(root).render(_jsx(React.StrictMode, { children: _jsx(ErrorBoundary, { children: _jsx(BrowserRouter, { children: _jsx(App, {}) }) }) }));
