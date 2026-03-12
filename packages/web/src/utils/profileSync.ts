import type { UpdateUserRequest } from '@backspace/shared';
import { useAuthStore } from '../stores/authStore';
import { useInstanceStore, type ConnectedInstance } from '../stores/instanceStore';
import { api } from '../api/client';

// ─── Internal helper ────────────────────────────────────────────────────────

async function downloadAsset(filename: string, origin?: string): Promise<Blob> {
  if (filename.startsWith('http') || filename.startsWith('blob:')) {
    const res = await fetch(filename);
    return res.blob();
  }
  const base = origin ? `${origin}/api/uploads/${filename}` : `/api/uploads/${filename}`;
  const res = await fetch(base);
  return res.blob();
}

// ─── Full profile sync (connect / reconnect) ────────────────────────────────

/**
 * Bidirectional profile sync with a single remote instance using LWW timestamps.
 * - If home is newer (or both equal): push home → remote (existing behavior)
 * - If remote is newer: pull remote → home, then relay to all other remotes
 * - If equal: no-op
 */
export async function syncProfileToRemote(inst: ConnectedInstance): Promise<void> {
  try {
    const homeUser = useAuthStore.getState().user;
    if (!homeUser) return;

    const homeTs = homeUser.profileUpdatedAt ?? 0;
    const remoteTs = inst.user?.profileUpdatedAt ?? 0;

    if (homeTs >= remoteTs) {
      // Home is newer (or equal) — push to remote
      await pushProfileToRemote(inst, homeUser);
    } else {
      // Remote is newer — pull from remote to home, then relay
      await pullProfileFromRemote(inst);
    }
  } catch (err) {
    console.warn(`[ProfileSync] Full sync with ${inst.origin} failed:`, err);
  }
}

/**
 * Push the home profile to a single remote instance.
 */
async function pushProfileToRemote(inst: ConnectedInstance, homeUser: NonNullable<ReturnType<typeof useAuthStore.getState>['user']>): Promise<void> {
  const payload: UpdateUserRequest = {
    displayName: homeUser.displayName || undefined,
    avatarColor: homeUser.avatarColor || undefined,
    accentColor: homeUser.accentColor || undefined,
    bio: homeUser.bio || undefined,
    customStatus: homeUser.customStatus || undefined,
    status: homeUser.status || undefined,
    profileUpdatedAt: homeUser.profileUpdatedAt,
  };

  // Sync avatar
  if (homeUser.avatar) {
    try {
      const blob = await downloadAsset(homeUser.avatar);
      const attachment = await inst.api.uploads.upload(new File([blob], homeUser.avatar));
      payload.avatar = attachment.filename;
    } catch (err) {
      console.warn('[ProfileSync] Failed to upload avatar to remote:', err);
    }
  } else {
    payload.avatar = '';
  }

  // Sync banner
  if (homeUser.banner) {
    try {
      const blob = await downloadAsset(homeUser.banner);
      const attachment = await inst.api.uploads.upload(new File([blob], homeUser.banner));
      payload.banner = attachment.filename;
    } catch (err) {
      console.warn('[ProfileSync] Failed to upload banner to remote:', err);
    }
  } else {
    payload.banner = '';
  }

  await inst.api.users.update(payload);
}

/**
 * Pull a remote instance's newer profile to the browsing (home) instance,
 * then relay to all other connected remotes.
 */
async function pullProfileFromRemote(inst: ConnectedInstance): Promise<void> {
  const remoteUser = inst.user;
  if (!remoteUser) return;

  const payload: UpdateUserRequest = {
    displayName: remoteUser.displayName || undefined,
    avatarColor: remoteUser.avatarColor || undefined,
    accentColor: remoteUser.accentColor || undefined,
    bio: remoteUser.bio || undefined,
    customStatus: remoteUser.customStatus || undefined,
    profileUpdatedAt: remoteUser.profileUpdatedAt,
  };

  // Download and re-upload avatar from remote → home
  if (remoteUser.avatar) {
    try {
      const blob = await downloadAsset(remoteUser.avatar, inst.origin);
      const attachment = await api.uploads.upload(new File([blob], remoteUser.avatar.split('/').pop() || 'avatar'));
      payload.avatar = attachment.filename;
    } catch (err) {
      console.warn('[ProfileSync] Failed to download/upload avatar from remote:', err);
    }
  } else {
    payload.avatar = '';
  }

  // Download and re-upload banner from remote → home
  if (remoteUser.banner) {
    try {
      const blob = await downloadAsset(remoteUser.banner, inst.origin);
      const attachment = await api.uploads.upload(new File([blob], remoteUser.banner.split('/').pop() || 'banner'));
      payload.banner = attachment.filename;
    } catch (err) {
      console.warn('[ProfileSync] Failed to download/upload banner from remote:', err);
    }
  } else {
    payload.banner = '';
  }

  // PATCH browsing instance (home) with the remote's newer data
  const updatedUser = await api.users.update(payload);
  useAuthStore.getState().setUser(updatedUser);

  // Relay to all OTHER connected remotes (exclude the source)
  const { instances } = useInstanceStore.getState();
  const otherConnected = instances.filter(i => i.status === 'connected' && i.origin !== inst.origin);
  if (otherConnected.length > 0) {
    await Promise.allSettled(
      otherConnected.map(other => pushProfileToRemote(other, updatedUser))
    );
  }
}

// ─── Incremental sync (profile update) ──────────────────────────────────────

/** Sync-eligible text fields (no replicatedInstances, homeUserId). */
const SYNC_FIELDS = ['displayName', 'avatarColor', 'accentColor', 'bio', 'customStatus', 'status'] as const;

/**
 * Push a partial profile update to all connected remote instances.
 * Called after a successful home PATCH from authStore.updateProfile.
 */
export async function syncProfileUpdateToRemotes(update: Partial<UpdateUserRequest>): Promise<void> {
  try {
    const { instances } = useInstanceStore.getState();
    const connected = instances.filter(i => i.status === 'connected');
    if (connected.length === 0) return;

    // Pick text fields that were actually in the update
    const basePayload: UpdateUserRequest = {};
    for (const key of SYNC_FIELDS) {
      if (key in update) {
        (basePayload as Record<string, unknown>)[key] = update[key as keyof UpdateUserRequest];
      }
    }

    // Include the LWW timestamp so remotes can reject stale writes
    basePayload.profileUpdatedAt = useAuthStore.getState().user?.profileUpdatedAt;

    // Pre-download file assets once (if they changed)
    let avatarBlob: Blob | null = null;
    let avatarFilename: string | null = null;
    let bannerBlob: Blob | null = null;
    let bannerFilename: string | null = null;

    if ('avatar' in update) {
      if (update.avatar) {
        try {
          avatarBlob = await downloadAsset(update.avatar);
          avatarFilename = update.avatar;
        } catch (err) {
          console.warn('[ProfileSync] Failed to download avatar for sync:', err);
        }
      }
    }

    if ('banner' in update) {
      if (update.banner) {
        try {
          bannerBlob = await downloadAsset(update.banner);
          bannerFilename = update.banner;
        } catch (err) {
          console.warn('[ProfileSync] Failed to download banner for sync:', err);
        }
      }
    }

    await Promise.allSettled(
      connected.map(async (inst) => {
        const perInstPayload: UpdateUserRequest = { ...basePayload };

        // Handle avatar
        if ('avatar' in update) {
          if (avatarBlob && avatarFilename) {
            try {
              const attachment = await inst.api.uploads.upload(new File([avatarBlob], avatarFilename));
              perInstPayload.avatar = attachment.filename;
            } catch (err) {
              console.warn(`[ProfileSync] Failed to upload avatar to ${inst.origin}:`, err);
            }
          } else {
            perInstPayload.avatar = '';
          }
        }

        // Handle banner
        if ('banner' in update) {
          if (bannerBlob && bannerFilename) {
            try {
              const attachment = await inst.api.uploads.upload(new File([bannerBlob], bannerFilename));
              perInstPayload.banner = attachment.filename;
            } catch (err) {
              console.warn(`[ProfileSync] Failed to upload banner to ${inst.origin}:`, err);
            }
          } else {
            perInstPayload.banner = '';
          }
        }

        // Only PATCH if there's something to sync
        if (Object.keys(perInstPayload).length > 0) {
          await inst.api.users.update(perInstPayload);
        }
      })
    );
  } catch (err) {
    console.warn('[ProfileSync] Failed to sync update to remotes:', err);
  }
}
