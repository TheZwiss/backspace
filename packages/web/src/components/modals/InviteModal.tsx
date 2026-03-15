import React, { useState, useEffect } from 'react';
import { Modal } from '../ui/Modal';
import { useUIStore } from '../../stores/uiStore';
import { useSpaceStore } from '../../stores/spaceStore';
import { isElectron } from '../../platform/platform';

export function InviteModal() {
  const [inviteCode, setInviteCode] = useState('');
  const [copied, setCopied] = useState(false);
  const [copiedDeepLink, setCopiedDeepLink] = useState(false);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState('');
  const activeModal = useUIStore((s) => s.activeModal);
  const closeModal = useUIStore((s) => s.closeModal);
  const generateInvite = useSpaceStore((s) => s.generateInvite);
  const currentSpaceId = useSpaceStore((s) => s.currentSpaceId);
  const spaces = useSpaceStore((s) => s.spaces);
  const currentSpace = spaces.find(s => s.id === currentSpaceId);
  const instanceOrigin = currentSpace?._instanceOrigin ?? '';

  const isOpen = activeModal === 'invite';
  const inviteUrl = inviteCode ? `${instanceOrigin || window.location.origin}/join/${inviteCode}` : '';

  // Deep link for Electron desktop app
  const deepLinkUrl = inviteCode
    ? instanceOrigin
      ? `backspace://join/${inviteCode}@${new URL(instanceOrigin).host}`
      : `backspace://join/${inviteCode}`
    : '';

  useEffect(() => {
    if (isOpen && currentSpaceId) {
      setIsLoading(true);
      setError('');
      generateInvite(currentSpaceId)
        .then(code => {
          setInviteCode(code);
          setIsLoading(false);
        })
        .catch((err) => {
          setError(err instanceof Error ? err.message : 'Failed to generate invite link');
          setIsLoading(false);
        });
    }
  }, [isOpen, currentSpaceId, generateInvite]);

  const handleCopy = async () => {
    if (!inviteUrl) return;
    try {
      await navigator.clipboard.writeText(inviteUrl);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      const input = document.querySelector<HTMLInputElement>('.invite-code-input');
      if (input) {
        input.select();
        document.execCommand('copy');
        setCopied(true);
        setTimeout(() => setCopied(false), 2000);
      }
    }
  };

  const handleCopyDeepLink = async () => {
    if (!deepLinkUrl) return;
    try {
      await navigator.clipboard.writeText(deepLinkUrl);
      setCopiedDeepLink(true);
      setTimeout(() => setCopiedDeepLink(false), 2000);
    } catch {
      // silently fail
    }
  };

  return (
    <Modal isOpen={isOpen} onClose={closeModal} title="Invite Friends">
      <p className="text-txt-secondary text-sm mb-4">
        Share this invite link with friends to let them join your space.
      </p>
      {error && (
        <div className="mb-3 p-2 bg-accent-rose/10 border border-accent-rose/30 rounded text-txt-danger text-sm">
          {error}
        </div>
      )}
      <div className="flex items-center gap-2">
        <input
          type="text"
          value={isLoading ? 'Generating...' : inviteUrl}
          readOnly
          className="input-standard invite-code-input flex-1 font-mono text-xs"
        />
        <button
          onClick={handleCopy}
          disabled={isLoading || !inviteUrl}
          className={`px-4 py-2 text-sm font-medium rounded transition-colors ${
            copied
              ? 'bg-status-online text-white'
              : 'bg-accent-primary hover:bg-accent-primary/80 text-white'
          }`}
        >
          {copied ? 'Copied!' : 'Copy'}
        </button>
      </div>
      {isElectron() && deepLinkUrl && (
        <div className="mt-3 flex items-center gap-2">
          <input
            type="text"
            value={deepLinkUrl}
            readOnly
            className="input-standard flex-1 font-mono text-xs"
          />
          <button
            onClick={handleCopyDeepLink}
            className={`px-4 py-2 text-sm font-medium rounded transition-colors ${
              copiedDeepLink
                ? 'bg-status-online text-white'
                : 'bg-surface-elevated hover:bg-surface-elevated/80 text-txt-secondary'
            }`}
          >
            {copiedDeepLink ? 'Copied!' : 'Copy'}
          </button>
        </div>
      )}
    </Modal>
  );
}
