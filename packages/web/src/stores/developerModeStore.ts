import { create } from 'zustand';

/**
 * Developer Mode: shows developer tools (today the Bots tab) in settings. The
 * switch lives with the account on the server (`users.developer_mode`), so
 * every device of the account agrees; this store only mirrors it. The server
 * value arrives with `ready` and with the `user_updated` another device causes,
 * and `DeveloperPanel` writes it through `PATCH /api/users/@me`.
 *
 * It only hides or shows UI. The API behind those tools stays available either
 * way, so this is not a security boundary.
 */

interface DeveloperModeState {
  enabled: boolean;
  setEnabled: (enabled: boolean) => void;
  reset: () => void;
}

export const useDeveloperModeStore = create<DeveloperModeState>((set) => ({
  enabled: false,
  setEnabled: (enabled) => set({ enabled }),
  reset: () => set({ enabled: false }),
}));
