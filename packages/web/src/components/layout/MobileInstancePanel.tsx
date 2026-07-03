import React, { useEffect, useState, useCallback } from 'react';
import { useUIStore } from '../../stores/uiStore';
import { useSettingsStore } from '../../stores/settingsStore';
import { MobileScreenHeader } from './MobileScreenHeader';
import { TransferIndicator } from './TransferIndicator';
import { api } from '../../api/client';
import { onFederationPeersChanged } from '../../hooks/useWebSocket';

type SectionDef = {
  id: 'general' | 'registration' | 'federation' | 'streaming' | 'storage' | 'users';
  label: string;
  icon: React.ReactNode;
};

const sections: SectionDef[] = [
  {
    id: 'general',
    label: 'General',
    icon: (
      <svg className="w-5 h-5 text-txt-secondary" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
        <path strokeLinecap="round" strokeLinejoin="round" d="M9.594 3.94c.09-.542.56-.94 1.11-.94h2.593c.55 0 1.02.398 1.11.94l.213 1.281c.063.374.313.686.645.87.074.04.147.083.22.127.325.196.72.257 1.075.124l1.217-.456a1.125 1.125 0 011.37.49l1.296 2.247a1.125 1.125 0 01-.26 1.431l-1.003.827c-.293.241-.438.613-.43.992a7.723 7.723 0 010 .255c-.008.378.137.75.43.991l1.004.827c.424.35.534.955.26 1.432l-1.298 2.247a1.125 1.125 0 01-1.369.491l-1.217-.456c-.355-.133-.75-.072-1.076.124a6.47 6.47 0 01-.22.128c-.331.183-.581.495-.644.869l-.213 1.281c-.09.543-.56.94-1.11.94h-2.594c-.55 0-1.019-.398-1.11-.94l-.213-1.281c-.062-.374-.312-.686-.644-.87a6.52 6.52 0 01-.22-.127c-.325-.196-.72-.257-1.076-.124l-1.217.456a1.125 1.125 0 01-1.369-.49l-1.297-2.247a1.125 1.125 0 01.26-1.432l1.004-.827c.292-.24.437-.613.43-.991a6.932 6.932 0 010-.255c.007-.38-.138-.751-.43-.992l-1.004-.827a1.125 1.125 0 01-.26-1.43l1.297-2.248a1.125 1.125 0 011.37-.491l1.216.456c.356.133.751.072 1.076-.124.072-.044.146-.086.22-.128.332-.183.582-.495.644-.869l.214-1.28z" />
        <path strokeLinecap="round" strokeLinejoin="round" d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
      </svg>
    ),
  },
  {
    id: 'registration',
    label: 'Registration',
    icon: (
      // Heroicon: ticket — represents invite-style/registration management
      <svg className="w-5 h-5 text-txt-secondary" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
        <path strokeLinecap="round" strokeLinejoin="round" d="M16.5 6v.75m0 3v.75m0 3v.75m0 3V18m-9-5.25h5.25M7.5 15h3M3.375 5.25c-.621 0-1.125.504-1.125 1.125v3.026a2.999 2.999 0 010 5.198v3.026c0 .621.504 1.125 1.125 1.125h17.25c.621 0 1.125-.504 1.125-1.125v-3.026a2.999 2.999 0 010-5.198V6.375c0-.621-.504-1.125-1.125-1.125H3.375z" />
      </svg>
    ),
  },
  {
    id: 'federation',
    label: 'Federation',
    icon: (
      // Heroicon: globe-alt — represents cross-instance federation
      <svg className="w-5 h-5 text-txt-secondary" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
        <path strokeLinecap="round" strokeLinejoin="round" d="M12 21a9.004 9.004 0 008.716-6.747M12 21a9.004 9.004 0 01-8.716-6.747M12 21c2.485 0 4.5-4.03 4.5-9S14.485 3 12 3m0 18c-2.485 0-4.5-4.03-4.5-9S9.515 3 12 3m0 0a8.997 8.997 0 017.843 4.582M12 3a8.997 8.997 0 00-7.843 4.582m15.686 0A11.953 11.953 0 0112 10.5c-2.998 0-5.74-1.1-7.843-2.918m15.686 0A8.959 8.959 0 0121 12c0 .778-.099 1.533-.284 2.253m0 0A17.919 17.919 0 0112 16.5c-3.162 0-6.133-.815-8.716-2.247m0 0A9.015 9.015 0 013 12c0-1.605.42-3.113 1.157-4.418" />
      </svg>
    ),
  },
  {
    id: 'streaming',
    label: 'Streaming',
    icon: (
      <svg className="w-5 h-5 text-txt-secondary" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
        <path strokeLinecap="round" strokeLinejoin="round" d="M15.75 10.5l4.72-4.72a.75.75 0 011.28.53v11.38a.75.75 0 01-1.28.53l-4.72-4.72M4.5 18.75h9a2.25 2.25 0 002.25-2.25v-9a2.25 2.25 0 00-2.25-2.25h-9A2.25 2.25 0 002.25 7.5v9a2.25 2.25 0 002.25 2.25z" />
      </svg>
    ),
  },
  {
    id: 'storage',
    label: 'Storage',
    icon: (
      <svg className="w-5 h-5 text-txt-secondary" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
        <path strokeLinecap="round" strokeLinejoin="round" d="M20.25 6.375c0 2.278-3.694 4.125-8.25 4.125S3.75 8.653 3.75 6.375m16.5 0c0-2.278-3.694-4.125-8.25-4.125S3.75 4.097 3.75 6.375m16.5 0v11.25c0 2.278-3.694 4.125-8.25 4.125s-8.25-1.847-8.25-4.125V6.375m16.5 0v3.75m-16.5-3.75v3.75m16.5 0v3.75C20.25 16.153 16.556 18 12 18s-8.25-1.847-8.25-4.125v-3.75m16.5 0c0 2.278-3.694 4.125-8.25 4.125s-8.25-1.847-8.25-4.125" />
      </svg>
    ),
  },
  {
    id: 'users',
    label: 'Users',
    icon: (
      <svg className="w-5 h-5 text-txt-secondary" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
        <path strokeLinecap="round" strokeLinejoin="round" d="M15 19.128a9.38 9.38 0 002.625.372 9.337 9.337 0 004.121-.952 4.125 4.125 0 00-7.533-2.493M15 19.128v-.003c0-1.113-.285-2.16-.786-3.07M15 19.128v.106A12.318 12.318 0 018.624 21c-2.331 0-4.512-.645-6.374-1.766l-.001-.109a6.375 6.375 0 0111.964-3.07M12 6.375a3.375 3.375 0 11-6.75 0 3.375 3.375 0 016.75 0zm8.25 2.25a2.625 2.625 0 11-5.25 0 2.625 2.625 0 015.25 0z" />
      </svg>
    ),
  },
];

/**
 * Federation approval-count badge source.
 *
 * Mirrors the desktop InstancePanel/FederationPanel contract: the count comes
 * from `api.federation.approvalRequests()` and is kept fresh by the
 * `onFederationPeersChanged` WebSocket signal that FederationPanel itself
 * subscribes to. We can't read FederationPanel's internal state from here, so
 * we fetch the same endpoint independently — and we wire MobileShell to forward
 * `onApprovalCountChange` callbacks from FederationPanel into a shared store
 * slot so the badge updates live while the admin is inside the panel.
 */
function useFederationApprovalCount(enabled: boolean) {
  const liveCount = useUIStore((s) => s.federationApprovalCount);
  const setLiveCount = useUIStore((s) => s.setFederationApprovalCount);

  const refetch = useCallback(async () => {
    if (!enabled) return;
    try {
      const result = await api.federation.approvalRequests();
      setLiveCount(result.requests.length);
    } catch {
      // Silently ignore — badge simply won't update on transient failures
    }
  }, [enabled, setLiveCount]);

  useEffect(() => {
    refetch();
  }, [refetch]);

  // Re-fetch when peer state changes (mirrors FederationPanel's own listener)
  useEffect(() => {
    if (!enabled) return;
    let timeout: ReturnType<typeof setTimeout> | undefined;
    const unsub = onFederationPeersChanged(() => {
      if (timeout) clearTimeout(timeout);
      timeout = setTimeout(() => {
        refetch();
      }, 500);
    });
    return () => {
      unsub();
      if (timeout) clearTimeout(timeout);
    };
  }, [enabled, refetch]);

  return liveCount;
}

export function MobileInstancePanel() {
  const pushMobileScreen = useUIStore((s) => s.pushMobileScreen);
  const fetchInstanceSettings = useSettingsStore((s) => s.fetchInstanceSettings);
  const fetchStreamingLimits = useSettingsStore((s) => s.fetchStreamingLimits);

  // Pre-fetch instance data so sub-panels have it when they mount
  // (mirrors InstancePanel.tsx useEffect on desktop)
  useEffect(() => {
    fetchInstanceSettings();
    fetchStreamingLimits();
  }, [fetchInstanceSettings, fetchStreamingLimits]);

  const approvalCount = useFederationApprovalCount(true);

  return (
    <div className="flex flex-col h-full bg-surface-base">
      <MobileScreenHeader title="Instance" rightActions={<TransferIndicator />} />
      <div className="flex-1 overflow-y-auto">
        {sections.map((section) => {
          const badge = section.id === 'federation' && approvalCount > 0 ? approvalCount : null;
          return (
            <button
              key={section.id}
              onClick={() => pushMobileScreen(`settings-instance-${section.id}`)}
              className="w-full flex items-center gap-3 px-4 py-3.5 hover:bg-interactive-hover text-left transition-colors"
            >
              {section.icon}
              <span className="text-sm text-txt-primary flex-1">{section.label}</span>
              {badge !== null && (
                <span className="min-w-[18px] h-[18px] px-1.5 bg-notification text-white text-[10px] font-bold rounded-full flex items-center justify-center">
                  {badge > 99 ? '99+' : badge}
                </span>
              )}
              <svg className="w-4 h-4 text-txt-tertiary" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M8.25 4.5l7.5 7.5-7.5 7.5" />
              </svg>
            </button>
          );
        })}
      </div>
    </div>
  );
}
