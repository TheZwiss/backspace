import { attentionMuted } from '../stores/attentionMutes';
import { useAuthStore } from '../stores/authStore';
import { useSpaceStore } from '../stores/spaceStore';
import { userKey } from './identity';
import i18n from '../i18n';
import type { NudgeEffect } from '@backspace/shared';
import { useNudgePreferences } from '../stores/nudgePreferences';
import { resolveNudgePlan, resolveWebNudgePlan, type NudgeContext } from './nudgePolicy';
import { playInAppNudge, playNudgeTone } from './inAppNudge';
import { isElectron } from '../platform/platform';
import { sendNotification } from '../platform/notifications';
import { alertsAllowed } from './alerts';

export async function notifyNudge(sender: string, avatar: string | null | undefined, origin: string, channelId: string, effect: NudgeEffect = 'shake', senderId?: string): Promise<void> {
  const rules = useNudgePreferences.getState();
  if (rules.scope === 'off') return;
  const self = useAuthStore.getState().user;
  const senderUser = senderId ? useSpaceStore.getState().dmChannels.find(dm => dm.id === channelId)?.members.find(member => member.id === senderId) ?? { id: senderId } : null;
  if (self && senderUser && attentionMuted(userKey(self, ''), senderUser, origin)) return;
  const isWeb = !isElectron();
  const fallback: NudgeContext = { focused: document.hasFocus(), minimized: document.visibilityState === 'hidden',
    displays: [{ id: 0, label: 'Monitor', primary: true, app: true }], gameRunning: false, foregroundGame: false,
    gameDisplayIds: [], gameDetectionUncertain: true };
  const needsGameScan = rules.gameAction !== 'normal' && (rules.gameDetection === 'auto'
    || (rules.gameDetection === 'on' && rules.gameAction === 'other-displays' && rules.gameMonitor === 'auto'))
    && !(rules.gameDetection === 'auto' && rules.gameTrigger === 'foreground' && document.hasFocus());
  const context = await window.backspace?.getNudgeContext?.(needsGameScan).catch(() => null) ?? fallback;
  const webPlan = isWeb ? resolveWebNudgePlan(rules, { focused: document.hasFocus(), hidden: document.visibilityState === 'hidden' }) : null;
  const plan = webPlan ?? resolveNudgePlan(rules, context);
  if (plan.destination === 'off') return;
  if (webPlan?.background) {
    // Background tab: no overlay is possible, so a tone plus a system notification carries the call.
    if (!alertsAllowed('message')) return;
    if (plan.sound) playNudgeTone(plan.volume);
    sendNotification(sender, i18n.t('chat:nudge.notice'), { silent: true, origin, channelId });
    return;
  }
  let image: string | undefined;
  if (avatar) {
    try {
      const url = new URL(avatar.startsWith('http') || avatar.startsWith('/') ? avatar : `/api/uploads/${avatar}`, origin || window.location.origin);
      const response = await fetch(url, { signal: AbortSignal.timeout(800) });
      const blob = await response.blob();
      if (response.ok && blob.size <= 1_000_000 && /^image\/(png|jpeg|webp|gif)$/.test(blob.type)) {
        image = await new Promise<string>((resolve, reject) => {
          const reader = new FileReader();
          reader.onload = () => resolve(String(reader.result));
          reader.onerror = reject;
          reader.readAsDataURL(blob);
        });
      }
    } catch { /* An unavailable avatar uses the sender's initial. */ }
  }
  if (self && useAuthStore.getState().user?.id !== self.id) return;
  if (useNudgePreferences.getState().scope === 'off' || (self && senderUser && attentionMuted(userKey(self, ''), senderUser, origin))) return;
  if (plan.destination === 'app') await playInAppNudge(sender, image, channelId, effect, plan);
  else window.backspace?.playNudge?.(sender, image, channelId, { labels: { notice: i18n.t('chat:nudge.notice'), close: i18n.t('common:actions.close') }, effect, mode: plan.mode, displayIds: plan.displayIds, sound: plan.sound, volume: plan.volume });
}
