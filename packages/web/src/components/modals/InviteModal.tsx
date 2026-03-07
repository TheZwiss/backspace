import React, { useState, useEffect } from 'react';
import { Modal } from '../ui/Modal';
import { useUIStore } from '../../stores/uiStore';
import { useServerStore } from '../../stores/serverStore';

export function InviteModal() {
  const [inviteCode, setInviteCode] = useState('');
  const [copied, setCopied] = useState(false);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState('');
  const activeModal = useUIStore((s) => s.activeModal);
  const closeModal = useUIStore((s) => s.closeModal);
  const generateInvite = useServerStore((s) => s.generateInvite);
  const currentServerId = useServerStore((s) => s.currentServerId);
  const servers = useServerStore((s) => s.servers);
  const currentServer = servers.find(s => s.id === currentServerId);
  const instanceOrigin = currentServer?._instanceOrigin ?? '';

  const isOpen = activeModal === 'invite';
  const inviteUrl = inviteCode ? `${instanceOrigin || window.location.origin}/join/${inviteCode}` : '';

  useEffect(() => {
    if (isOpen && currentServerId) {
      setIsLoading(true);
      setError('');
      generateInvite(currentServerId)
        .then(code => {
          setInviteCode(code);
          setIsLoading(false);
        })
        .catch((err) => {
          setError(err instanceof Error ? err.message : 'Failed to generate invite link');
          setIsLoading(false);
        });
    }
  }, [isOpen, currentServerId, generateInvite]);

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

  return (
    <Modal isOpen={isOpen} onClose={closeModal} title="Invite Friends">
      <p className="text-txt-secondary text-sm mb-4">
        Share this invite link with friends to let them join your server.
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
          className="invite-code-input flex-1 px-3 py-2 bg-surface-input rounded text-txt-primary outline-none font-mono text-xs"
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
    </Modal>
  );
}
