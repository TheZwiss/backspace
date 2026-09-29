import { useCallback, useEffect, useRef, useState } from 'react';
import { getApiForOrigin, type TaggedSpace } from '../stores/spaceStore';
import { describeError } from '../i18n/errors';
import { permissionsToString } from '../utils/permissions';
import {
  findOverride,
  overrideBitsOf,
  withOverrideBits,
  type OverrideBitState,
  type StoredOverride,
} from '../utils/overrideBits';

/** Which kind of entity carries the overrides: the two share one route shape. */
export type OverrideEntityKind = 'channel' | 'category';

export interface EntityOverrides {
  /** The overrides as the server last listed them. */
  overrides: StoredOverride[];
  /** False until the first listing has come back (or failed). */
  loaded: boolean;
  /** Why the last listing failed, in the user's language; empty when it did not. */
  error: string;
  /** List the overrides again. */
  reload: () => Promise<void>;
  /** Write one whole override row. */
  put: (row: StoredOverride) => Promise<unknown>;
  /** Remove one override row. */
  remove: (targetType: string, targetId: string) => Promise<unknown>;
  /**
   * Put `bits` of one target's override in `state` and leave every other bit
   * of it alone: the row is written with the change, or removed when nothing
   * is left on it. Then the list is read again. Rejects with the server's
   * error when the write is refused.
   */
  setBits: (targetType: string, targetId: string, bits: bigint, state: OverrideBitState) => Promise<void>;
}

/**
 * The overrides of one channel or category, from the space's own instance
 * (client-federation.md). One list per open settings dialog: every tab and
 * control of it reads and edits this list, so none of them holds a copy that
 * can go stale. `enabled` false (the viewer cannot read overrides) fetches
 * nothing.
 */
export function useEntityOverrides(
  kind: OverrideEntityKind,
  entityId: string | undefined,
  space: Pick<TaggedSpace, '_instanceOrigin'> | undefined,
  enabled: boolean,
): EntityOverrides {
  const [overrides, setOverrides] = useState<StoredOverride[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState('');
  // Only the newest listing may land; an older one answering late would put
  // back what a write just changed.
  const requestSeq = useRef(0);

  const origin = space?._instanceOrigin ?? '';
  const routes = useCallback(() => {
    const client = getApiForOrigin(origin);
    return kind === 'channel' ? client.channels : client.categories;
  }, [kind, origin]);

  const reload = useCallback(async (): Promise<void> => {
    if (!entityId || !enabled) return;
    const seq = ++requestSeq.current;
    try {
      const rows = await routes().getOverrides(entityId);
      if (seq !== requestSeq.current) return;
      setOverrides(rows.map(({ targetType, targetId, allow, deny }) => ({ targetType, targetId, allow, deny })));
      setError('');
    } catch (err) {
      if (seq !== requestSeq.current) return;
      setError(describeError(err));
    } finally {
      if (seq === requestSeq.current) setLoaded(true);
    }
  }, [entityId, enabled, routes]);

  useEffect(() => {
    setOverrides([]);
    setError('');
    // Nothing to wait for when there is nothing to fetch.
    setLoaded(!entityId || !enabled);
    void reload();
  }, [reload, entityId, enabled]);

  const put = useCallback((row: StoredOverride) => {
    if (!entityId) return Promise.reject(new Error('no entity'));
    return routes().putOverride(entityId, row);
  }, [entityId, routes]);

  const remove = useCallback((targetType: string, targetId: string) => {
    if (!entityId) return Promise.reject(new Error('no entity'));
    return routes().deleteOverride(entityId, targetType, targetId);
  }, [entityId, routes]);

  const setBits = useCallback(async (targetType: string, targetId: string, bits: bigint, state: OverrideBitState) => {
    const current = overrideBitsOf(findOverride(overrides, targetType, targetId));
    const next = withOverrideBits(current, bits, state);
    try {
      if (next) {
        await put({ targetType, targetId, allow: permissionsToString(next.allow), deny: permissionsToString(next.deny) });
      } else if (current) {
        await remove(targetType, targetId);
      }
    } finally {
      await reload();
    }
  }, [overrides, put, remove, reload]);

  return { overrides, loaded, error, reload, put, remove, setBits };
}
