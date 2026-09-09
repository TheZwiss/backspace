// Shared bootstrap for scene workbench pages: the i18n catalogs (the scenes
// render real labels through t()), the interface scale, and a state forced
// from the URL so a static screenshot can show hover, focus or press without a
// pointer. `?state=hover` puts .is-hover on the page root; `focus` and `active`
// likewise. Nothing in the app imports this file.
import type { ReactNode } from 'react';
import { createRoot } from 'react-dom/client';
import { initI18n } from '../i18n';
import { initializeInterfaceScale } from '../platform/interfaceScale';
import '../styles/globals.css';

export function forcedStateClass(): string {
  const state = new URLSearchParams(window.location.search).get('state');
  if (state === 'hover' || state === 'focus' || state === 'active') return `is-${state}`;
  return '';
}

export async function mountScenePage(node: ReactNode): Promise<void> {
  initializeInterfaceScale();
  await initI18n();
  const host = document.getElementById('root');
  if (!host) throw new Error('missing #root');
  host.className = forcedStateClass();
  createRoot(host).render(node);
}
