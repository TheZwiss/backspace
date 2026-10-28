import type { ChosenUserStatus } from '@backspace/shared';

export type ChosenStatusLabelKey =
  | 'common:states.online'
  | 'common:states.idle'
  | 'common:states.doNotDisturb';

export interface ChosenStatusOption {
  value: ChosenUserStatus;
  labelKey: ChosenStatusLabelKey;
  dotClass: string;
}

export const CHOSEN_STATUS_OPTIONS: readonly ChosenStatusOption[] = [
  { value: 'online', labelKey: 'common:states.online', dotClass: 'bg-status-online' },
  { value: 'idle', labelKey: 'common:states.idle', dotClass: 'bg-status-idle' },
  { value: 'dnd', labelKey: 'common:states.doNotDisturb', dotClass: 'bg-status-dnd' },
];
