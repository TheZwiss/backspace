import { useState, useEffect, useCallback } from 'react';
import { api } from '../../../api/client';
import type { StorageStats, CleanupResult } from '@backspace/shared';

function formatBytes(bytes: number): string {
  if (bytes === 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB'];
  const i = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  const value = bytes / Math.pow(1024, i);
  return `${value < 10 ? value.toFixed(2) : value < 100 ? value.toFixed(1) : Math.round(value)} ${units[i]}`;
}

export function StoragePanel() {
  const [stats, setStats] = useState<StorageStats | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [cleanupResult, setCleanupResult] = useState<CleanupResult | null>(null);
  const [cleaning, setCleaning] = useState(false);
  const [previewDone, setPreviewDone] = useState(false);

  const fetchStats = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const data = await api.admin.storageStats();
      setStats(data);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load storage stats');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchStats();
  }, [fetchStats]);

  const handleCleanup = async (dryRun: boolean) => {
    setCleaning(true);
    setCleanupResult(null);
    setError('');
    try {
      const result = await api.admin.storageCleanup(dryRun);
      setCleanupResult(result);
      if (dryRun) {
        setPreviewDone(true);
      } else {
        setPreviewDone(false);
        await fetchStats();
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Cleanup failed');
    } finally {
      setCleaning(false);
    }
  };

  if (loading) {
    return <div className="text-sm text-txt-tertiary">Loading storage stats...</div>;
  }

  if (error && !stats) {
    return (
      <div className="space-y-3">
        <div className="p-2 bg-accent-rose/10 border border-accent-rose/30 rounded text-txt-danger text-sm">{error}</div>
        <button onClick={fetchStats} className="text-sm text-accent-primary hover:underline">Retry</button>
      </div>
    );
  }

  if (!stats) return null;

  const hasOrphans = stats.orphanedFiles > 0 || stats.unlinkedAttachments > 0;

  return (
    <div className="space-y-5">
      <h2 className="text-lg font-semibold text-txt-primary">Storage</h2>
      <div className="text-xs text-txt-tertiary">
        Monitor disk usage and clean up orphaned files left behind by deleted content or replaced avatars/banners.
      </div>

      {/* Storage Overview */}
      <div>
        <div className="text-[11px] font-semibold text-txt-tertiary uppercase tracking-wider mb-1.5">Storage Overview</div>
        <div className="grid grid-cols-2 gap-2">
          <div className="rounded-lg bg-white/[0.02] p-3.5">
            <div className="text-xs text-txt-tertiary mb-0.5">Total Files</div>
            <div className="text-lg font-semibold text-txt-primary">{stats.totalFiles}</div>
            <div className="text-xs text-txt-tertiary">{formatBytes(stats.totalSize)}</div>
          </div>
          <div className="rounded-lg bg-white/[0.02] p-3.5">
            <div className="text-xs text-txt-tertiary mb-0.5">Referenced</div>
            <div className="text-lg font-semibold text-txt-primary">{stats.referencedFiles}</div>
            <div className="text-xs text-txt-tertiary">{formatBytes(stats.referencedSize)}</div>
          </div>
          <div className="rounded-lg bg-white/[0.02] p-3.5">
            <div className="text-xs text-txt-tertiary mb-0.5">Orphaned Files</div>
            <div className={`text-lg font-semibold ${stats.orphanedFiles > 0 ? 'text-accent-amber' : 'text-txt-primary'}`}>
              {stats.orphanedFiles}
            </div>
            <div className="text-xs text-txt-tertiary">{formatBytes(stats.orphanedSize)}</div>
          </div>
          <div className="rounded-lg bg-white/[0.02] p-3.5">
            <div className="text-xs text-txt-tertiary mb-0.5">Unlinked Uploads</div>
            <div className={`text-lg font-semibold ${stats.unlinkedAttachments > 0 ? 'text-accent-amber' : 'text-txt-primary'}`}>
              {stats.unlinkedAttachments}
            </div>
            <div className="text-xs text-txt-tertiary">{formatBytes(stats.unlinkedSize)}</div>
          </div>
        </div>
      </div>

      {/* File Type Breakdown */}
      {stats.breakdown.length > 0 && (
        <div>
          <div className="text-[11px] font-semibold text-txt-tertiary uppercase tracking-wider mb-1.5">File Type Breakdown</div>
          <div className="rounded-lg bg-white/[0.02] p-3.5">
            <div className="space-y-1.5">
              {stats.breakdown.map((b) => (
                <div key={b.type} className="flex items-center justify-between text-sm">
                  <span className="text-txt-secondary capitalize">{b.type}</span>
                  <span className="text-txt-tertiary">
                    {b.count} file{b.count !== 1 ? 's' : ''} — {formatBytes(b.size)}
                  </span>
                </div>
              ))}
            </div>
          </div>
        </div>
      )}

      {/* Cleanup Actions */}
      <div>
        <div className="text-[11px] font-semibold text-txt-tertiary uppercase tracking-wider mb-1.5">Cleanup</div>
        <div className="rounded-lg bg-white/[0.02] p-3.5 space-y-3">
          {!hasOrphans && (
            <div className="text-sm text-txt-tertiary">No orphaned files or stale uploads found.</div>
          )}

          {hasOrphans && (
            <div className="flex gap-2">
              <button
                onClick={() => handleCleanup(true)}
                disabled={cleaning}
                className="px-3 py-1.5 bg-white/[0.06] hover:bg-white/[0.1] text-txt-secondary text-sm font-medium rounded-lg transition-colors disabled:opacity-50"
              >
                {cleaning ? 'Scanning...' : 'Preview Cleanup'}
              </button>
              <button
                onClick={() => handleCleanup(false)}
                disabled={cleaning || !previewDone}
                className="px-3 py-1.5 bg-accent-rose hover:bg-accent-rose/80 text-white text-sm font-medium rounded-lg transition-colors disabled:opacity-50"
              >
                {cleaning ? 'Cleaning...' : 'Clean Up Now'}
              </button>
            </div>
          )}

          {cleanupResult && (
            <div className={`p-2 rounded text-sm ${
              cleanupResult.dryRun
                ? 'bg-accent-amber/10 border border-accent-amber/30 text-accent-amber'
                : 'bg-status-online/10 border border-status-online/30 text-status-online'
            }`}>
              <div className="font-medium mb-1">
                {cleanupResult.dryRun ? 'Preview — no files deleted' : 'Cleanup complete'}
              </div>
              <div>
                {cleanupResult.deletedFiles} orphaned file{cleanupResult.deletedFiles !== 1 ? 's' : ''} ({formatBytes(cleanupResult.freedBytes)})
                {cleanupResult.deletedAttachmentRecords > 0 && (
                  <>, {cleanupResult.deletedAttachmentRecords} stale upload record{cleanupResult.deletedAttachmentRecords !== 1 ? 's' : ''}</>
                )}
              </div>
              {cleanupResult.errors.length > 0 && (
                <div className="mt-1 text-txt-danger">
                  {cleanupResult.errors.length} error{cleanupResult.errors.length !== 1 ? 's' : ''}: {cleanupResult.errors[0]}
                </div>
              )}
            </div>
          )}
        </div>
      </div>

      {/* Error / Refresh */}
      {error && (
        <div className="p-2 bg-accent-rose/10 border border-accent-rose/30 rounded text-txt-danger text-sm">{error}</div>
      )}

      <button
        onClick={() => { setCleanupResult(null); setPreviewDone(false); fetchStats(); }}
        className="text-sm text-accent-primary hover:underline"
      >
        Refresh Stats
      </button>
    </div>
  );
}
