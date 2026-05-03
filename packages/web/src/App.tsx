import React, { useEffect } from 'react';
import { Routes, Route, Navigate, useSearchParams } from 'react-router-dom';
import { LoginPage } from './components/auth/LoginPage';
import { RegisterPage } from './components/auth/RegisterPage';
import { AppLayout } from './components/layout/AppLayout';
import { JoinPage } from './components/JoinPage';
import { SwAutoUpdate } from './components/ui/SwUpdatePrompt';
import { ScreenSharePicker } from './components/voice/ScreenSharePicker';
import { useAuthStore } from './stores/authStore';
import { isElectron } from './platform/platform';

function ProtectedRoute({ children }: { children: React.ReactNode }) {
  const token = useAuthStore((s) => s.token);
  if (!token) return <Navigate to="/login" replace />;
  return <>{children}</>;
}

function AuthRedirect({ children }: { children: React.ReactNode }) {
  const token = useAuthStore((s) => s.token);
  const [searchParams] = useSearchParams();
  const redirect = searchParams.get('redirect');
  if (token) {
    if (redirect && redirect.startsWith('/') && !redirect.startsWith('//')) {
      return <Navigate to={redirect} replace />;
    }
    return <Navigate to="/channels/@me" replace />;
  }
  return <>{children}</>;
}

export function App() {
  // Boot-completion ping — disarms the main-process boot timer.
  // MUST be first hook on the unconditional render path. Single fire on
  // first commit; main owns "armed once" gating so duplicate calls (e.g.
  // ErrorBoundary path) are idempotent. Semantic: "renderer survived
  // render," NOT "data loaded." A spinner on screen counts as boot success.
  //
  // Gated on VITE_FORCE_BOOT_STALL so the smoke-test harness can build a
  // variant that intentionally never pings, exercising the renderer-stalled
  // recovery path without hand-editing source. Set 'true' / '1' to force stall.
  useEffect(() => {
    if (import.meta.env.VITE_FORCE_BOOT_STALL) return;
    if (typeof window.backspace?.rendererReady === 'function') {
      window.backspace.rendererReady();
    }
  }, []);

  const showTitleBar = isElectron();

  return (
    <div className={`flex flex-col ${showTitleBar ? 'h-screen' : 'contents'}`}>
      {showTitleBar && <>
        <div className="h-8 flex-shrink-0 bg-surface-base titlebar-drag" />
        <div className="h-px flex-shrink-0 bg-border-hard" />
      </>}
      <div className={showTitleBar ? 'flex-1 min-h-0' : 'contents'}>
        <SwAutoUpdate />
        <ScreenSharePicker />
        <Routes>
          <Route
            path="/login"
            element={
              <AuthRedirect>
                <LoginPage />
              </AuthRedirect>
            }
          />
          <Route
            path="/register"
            element={
              <AuthRedirect>
                <RegisterPage />
              </AuthRedirect>
            }
          />
          <Route
            path="/channels/:spaceId/:channelId?"
            element={
              <ProtectedRoute>
                <AppLayout />
              </ProtectedRoute>
            }
          />
          <Route
            path="/join/:inviteCode"
            element={<JoinPage />}
          />
          <Route
            path="/explore"
            element={
              <ProtectedRoute>
                <AppLayout />
              </ProtectedRoute>
            }
          />
          <Route path="/" element={<Navigate to="/channels/@me" replace />} />
          <Route path="*" element={<Navigate to="/channels/@me" replace />} />
        </Routes>
      </div>
    </div>
  );
}
