// Dev-only workbench for the stream quality controls. Nothing in the app imports
// this file; `dev-stream-settings.html` is its only entry. It renders the real
// `StreamQualityControls` inside the two surfaces that ship it (the live
// settings popover and the setup screen's drawer) with seeded stores, one scene
// per `?scene=` so every state can be screenshotted without a voice call.
import { createRoot } from 'react-dom/client';
import type { InstanceStreamingLimits } from '@backspace/shared';
import { StreamQualityControls, StreamSummary, StreamHostSubtitle } from '../components/voice/StreamQualityControls';
import { useVoiceStore } from '../stores/voiceStore';
import type { ScreenShareAudioState } from '../stores/voiceStore';
import { useSettingsStore } from '../stores/settingsStore';
import i18n, { initI18n } from '../i18n';
import { initializeInterfaceScale } from '../platform/interfaceScale';
import '../styles/globals.css';

const HOME_LIMITS: InstanceStreamingLimits = {
  maxBitrateKbps: 20000,
  minBitrateKbps: 500,
  bitrateStepKbps: 500,
  allowedResolutions: [540, 720, 1080, 1440, 'native'],
  allowedFramerates: [30, 60, 120],
  maxResolution: 1440,
  maxFramerate: 120,
  discoveryEnabled: true,
  directoryEnabled: false,
  directoryConfigured: false,
  bitrateMatrixOverrides: null,
  allowCustomBitrate: true,
};

const STRICT_LIMITS: InstanceStreamingLimits = {
  ...HOME_LIMITS,
  maxBitrateKbps: 3000,
  minBitrateKbps: 1000,
  allowedResolutions: [540, 720],
  allowedFramerates: [30],
  maxResolution: 720,
  maxFramerate: 30,
  allowCustomBitrate: false,
};

interface Scene {
  caption: string;
  origin: string;
  hostLimits: InstanceStreamingLimits;
  /** System audio of a live share; absent = not sharing (the setup screen's view). */
  live?: { audio: ScreenShareAudioState; preference: boolean };
  /** Render as the desktop app on this platform (a stub `window.backspace`, read for the platform notes). */
  desktopPlatform?: 'win32' | 'darwin' | 'linux';
}

const SCENES: Record<string, Scene> = {
  home: {
    caption: 'Home voice channel: home limits, no host line',
    origin: '',
    hostLimits: HOME_LIMITS,
  },
  remote: {
    caption: 'Federated space, saved 1080p60: the host allows 540p/720p, 30 fps, 3 Mbps, no custom bitrate',
    origin: 'https://orbit.ddns.net',
    hostLimits: STRICT_LIMITS,
  },
  'remote-long': {
    caption: 'Federated space on a host with a long name (wraps), saved 1080p60',
    origin: 'https://voice-and-streaming.a-rather-long-community-instance-name.example.org',
    hostLimits: { ...STRICT_LIMITS, allowCustomBitrate: true },
  },
  'live-published': {
    caption: 'Live share sending system audio: the switch is on and can be turned off',
    origin: '',
    hostLimits: HOME_LIMITS,
    live: { audio: 'published', preference: true },
  },
  'live-held': {
    caption: 'Browser share, audio turned off mid-stream: capture kept aside, the switch can turn it back on',
    origin: '',
    hostLimits: HOME_LIMITS,
    live: { audio: 'held', preference: false },
  },
  'live-acquiring': {
    caption: 'Desktop app (Windows), System Audio just turned on mid-stream: switch on and waiting while the loopback capture is taken',
    origin: '',
    hostLimits: HOME_LIMITS,
    live: { audio: 'acquiring', preference: true },
    desktopPlatform: 'win32',
  },
  'live-published-desktop': {
    caption: 'Desktop app (Windows), live share sending system audio',
    origin: '',
    hostLimits: HOME_LIMITS,
    live: { audio: 'published', preference: true },
    desktopPlatform: 'win32',
  },
  'live-unavailable': {
    caption: 'Browser share started without audio: cannot be added mid-stream, switch disabled and explained',
    origin: '',
    hostLimits: HOME_LIMITS,
    live: { audio: 'unavailable', preference: true },
  },
};

function seed(scene: Scene): void {
  if (scene.desktopPlatform) {
    (window as { backspace?: unknown }).backspace = { platform: scene.desktopPlatform };
  }
  useSettingsStore.setState({
    streamingLimits: scene.origin ? HOME_LIMITS : scene.hostLimits,
    streamingLimitsByOrigin: scene.origin ? { [scene.origin]: scene.hostLimits } : {},
  });
  useVoiceStore.setState({
    livekitHostOrigin: scene.origin,
    isScreenSharing: scene.live !== undefined,
    screenShareAudio: scene.live?.audio ?? null,
    screenShareConfig: {
      height: 1080, fps: 60, mode: 'gaming', customBitrateKbps: null,
      shareAudio: scene.live?.preference ?? true, codec: 'vp9',
    },
  });
}

/** Same frame as ScreenShareSettingsPopover, without the anchor positioning. */
function Popover() {
  return (
    <div className="w-[260px] glass rounded-lg overflow-hidden">
      <div className="px-3 py-2 border-b border-border-hard">
        <div className="text-[14px] font-bold text-txt-primary">{i18n.t('voice:streamSettings.title')}</div>
        <StreamHostSubtitle className="mt-0.5" />
      </div>
      <div className="px-3 py-3">
        <StreamQualityControls />
      </div>
      <div className="px-3 py-2 border-t border-border-hard">
        <StreamSummary />
      </div>
    </div>
  );
}

/** Same frame as the setup screen's quality drawer. */
function Drawer() {
  return (
    <div className="w-[340px] glass border-l border-border-hard flex flex-col shadow-2xl rounded-r-lg">
      <div className="flex items-start justify-between gap-3 px-5 pt-4 pb-3 border-b border-border-hard">
        <div className="min-w-0">
          <div className="text-[15px] font-bold text-txt-primary">{i18n.t('voice:streamSettings.title')}</div>
          <StreamHostSubtitle className="mt-0.5" />
        </div>
      </div>
      <div className="px-5 py-4">
        <StreamQualityControls />
      </div>
    </div>
  );
}

function Workbench({ scene }: { scene: Scene }) {
  return (
    <div style={{ minHeight: 'calc(100 * var(--app-vh))', background: 'rgb(var(--bg-chat))', padding: 32, display: 'flex', flexDirection: 'column', gap: 20 }}>
      <span style={{ fontSize: 12, color: 'rgb(var(--text-tertiary))' }}>{scene.caption}</span>
      <div style={{ display: 'flex', gap: 40, alignItems: 'flex-start' }}>
        <Popover />
        <Drawer />
      </div>
    </div>
  );
}

async function main(): Promise<void> {
  const host = document.getElementById('root');
  if (!host) throw new Error('missing #root');
  initializeInterfaceScale();
  const key = new URLSearchParams(window.location.search).get('scene') ?? 'remote';
  const scene = SCENES[key] ?? SCENES.remote!;
  await initI18n();
  seed(scene);
  createRoot(host).render(<Workbench scene={scene} />);
}

void main();
