import type { UpdateUserRequest } from '@backspace/shared';
import { useAuthStore } from '../stores/authStore';
import { useInstanceStore, type ConnectedInstance } from '../stores/instanceStore';

// ─── Internal helper ────────────────────────────────────────────────────────

async function downloadHomeAsset(filename: string): Promise<Blob> {
  if (filename.startsWith('http') || filename.startsWith('blob:')) {
    const res = await fetch(filename);
    return res.blob();
  }
  const res = await fetch(`/api/uploads/${filename}`);
  return res.blob();
}

// ─── Full profile sync (connect / reconnect) ────────────────────────────────

/**
 * Push the entire home profile to a single remote instance.
 * Called on initial connect, reconnect, and login-to-remote.
 */
export async function syncProfileToRemote(inst: ConnectedInstance): Promise<void> {
  try {
    const homeUser = useAuthStore.getState().user;
    if (!homeUser) return;

    const payload: UpdateUserRequest = {
      displayName: homeUser.displayName || undefined,
      avatarColor: homeUser.avatarColor || undefined,
      accentColor: homeUser.accentColor || undefined,
      bio: homeUser.bio || undefined,
      customStatus: homeUser.customStatus || undefined,
    };

    // Sync avatar
    if (homeUser.avatar) {
      try {
        const blob = await downloadHomeAsset(homeUser.avatar);
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
        const blob = await downloadHomeAsset(homeUser.banner);
        const attachment = await inst.api.uploads.upload(new File([blob], homeUser.banner));
        payload.banner = attachment.filename;
      } catch (err) {
        console.warn('[ProfileSync] Failed to upload banner to remote:', err);
      }
    } else {
      payload.banner = '';
    }

    await inst.api.users.update(payload);
  } catch (err) {
    console.warn(`[ProfileSync] Full sync to ${inst.origin} failed:`, err);
  }
}

// ─── Incremental sync (profile update) ──────────────────────────────────────

/** Sync-eligible text fields (no status, replicatedInstances, homeUserId). */
const SYNC_FIELDS = ['displayName', 'avatarColor', 'accentColor', 'bio', 'customStatus'] as const;

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

    // Pre-download file assets once (if they changed)
    let avatarBlob: Blob | null = null;
    let avatarFilename: string | null = null;
    let bannerBlob: Blob | null = null;
    let bannerFilename: string | null = null;

    if ('avatar' in update) {
      if (update.avatar) {
        try {
          avatarBlob = await downloadHomeAsset(update.avatar);
          avatarFilename = update.avatar;
        } catch (err) {
          console.warn('[ProfileSync] Failed to download avatar for sync:', err);
        }
      }
    }

    if ('banner' in update) {
      if (update.banner) {
        try {
          bannerBlob = await downloadHomeAsset(update.banner);
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
