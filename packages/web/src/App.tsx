import React from 'react';
import { Routes, Route, Navigate, useSearchParams } from 'react-router-dom';
import { LoginPage } from './components/auth/LoginPage';
import { RegisterPage } from './components/auth/RegisterPage';
import { AppLayout } from './components/layout/AppLayout';
import { JoinPage } from './components/JoinPage';
import { SwAutoUpdate } from './components/ui/SwUpdatePrompt';
import { useAuthStore } from './stores/authStore';

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
  return (
    <>
    <SwAutoUpdate />
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
    </>

  );
}
