// Dev-only workbench for the auth backdrop (scene bible row 2). Nothing in the
// app imports this file; `dev-auth-backdrop.html` is its only entry. It shows
// the four variants behind a replica of the real card at a desktop and a phone
// size. The live pages are also on this dev server at /login, /register and
// /join/not-a-real-code, and should be screenshotted too.
import type { ReactNode } from 'react';
import { AuthBackdrop, type AuthBackdropVariant } from '../components/auth/AuthBackdrop';
import { WorkbenchPage, Section } from './workbench';
import { mountScenePage } from './harness';

/** The auth page shell exactly as LoginPage lays it out: a relative, scrolling full-height column with the card centred. */
function AuthShell({ width, height, variant, children }: { width: number; height: number; variant: AuthBackdropVariant; children: ReactNode }) {
  return (
    <div style={{ width, height, borderRadius: 8, overflow: 'hidden', boxShadow: '0 0 0 1px rgb(var(--border-hard))' }}>
      <div className="h-full overflow-y-auto flex flex-col items-center bg-surface-base relative">
        <AuthBackdrop variant={variant} />
        {children}
      </div>
    </div>
  );
}

function LoginCard() {
  return (
    <div className="my-auto flex-shrink-0 w-full max-w-[480px] bg-surface-elevated rounded-md p-8 shadow-elevation-high relative z-10">
      <div className="text-center mb-6">
        <h1 className="text-2xl font-bold text-txt-primary">Welcome back!</h1>
        <p className="text-txt-tertiary mt-1">We're so excited to see you again!</p>
      </div>
      <div className="mb-5">
        <label className="block text-xs font-bold text-txt-secondary uppercase mb-2">Username <span className="text-txt-danger">*</span></label>
        <input className="input-standard w-full py-2.5" readOnly />
      </div>
      <div className="mb-5">
        <label className="block text-xs font-bold text-txt-secondary uppercase mb-2">Password <span className="text-txt-danger">*</span></label>
        <input type="password" className="input-standard w-full py-2.5" readOnly />
      </div>
      <button type="button" className="cta-primary w-full py-2.5 rounded">Log In</button>
      <p className="mt-4 text-txt-tertiary">Need an account? <span className="text-accent-primary">Register</span></p>
    </div>
  );
}

function InvalidCard() {
  return (
    <div className="my-auto flex-shrink-0 w-full max-w-[480px] bg-surface-elevated rounded-md p-8 shadow-elevation-high relative z-10 text-center">
      <div className="w-16 h-16 mx-auto mb-4 rounded-full bg-accent-rose/10 flex items-center justify-center">
        <svg className="w-8 h-8 text-accent-rose" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
          <path strokeLinecap="round" strokeLinejoin="round" d="M12 9v3.75m-9.303 3.376c-.866 1.5.217 3.374 1.948 3.374h14.71c1.73 0 2.813-1.874 1.948-3.374L13.949 3.378c-.866-1.5-3.032-1.5-3.898 0L2.697 16.126zM12 15.75h.007v.008H12v-.008z" />
        </svg>
      </div>
      <h1 className="text-xl font-bold text-txt-primary mb-2">Invalid Invite</h1>
      <p className="text-txt-tertiary mb-6">That invite code is not valid.</p>
      <button type="button" className="cta-primary px-6 py-2.5 rounded">Log In</button>
    </div>
  );
}

function Workbench() {
  return (
    <WorkbenchPage
      title="Auth backdrop — design workbench"
      description="The scene behind the login, register and invite cards, at a desktop and a phone size. The card is a replica of the real one; the live pages at /login, /register and /join/not-a-real-code on this server show the real thing."
    >
      <Section title="Login, 1440 × 900 (shown at 1200 × 750)">
        <AuthShell width={1200} height={750} variant="login"><LoginCard /></AuthShell>
      </Section>
      <Section title="Register and join share the shell (1200 × 750)">
        <div style={{ display: 'flex', gap: 24, flexWrap: 'wrap' }}>
          <AuthShell width={588} height={620} variant="register"><LoginCard /></AuthShell>
          <AuthShell width={588} height={620} variant="join"><LoginCard /></AuthShell>
        </div>
      </Section>
      <Section title="Invalid invite: the beacon has gone dark (1200 × 750)">
        <AuthShell width={1200} height={750} variant="invalid"><InvalidCard /></AuthShell>
      </Section>
      <Section title="Phone, 390 × 844">
        <div style={{ display: 'flex', gap: 24 }}>
          <AuthShell width={390} height={844} variant="login"><LoginCard /></AuthShell>
          <AuthShell width={390} height={844} variant="invalid"><InvalidCard /></AuthShell>
        </div>
      </Section>
    </WorkbenchPage>
  );
}

void mountScenePage(<Workbench />);
