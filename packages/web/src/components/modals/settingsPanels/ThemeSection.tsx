import { useTranslation } from 'react-i18next';
import { Toggle } from '../../ui/Toggle';
import { THEMES, useThemeStore, type ThemeId } from '../../../stores/themeStore';

/** Swatches mirror the theme's chat, sidebar and elevated surfaces. */
const SWATCHES: Record<ThemeId, { chat: string; side: string; raised: string }> = {
  'aether-drift': { chat: '#13131a', side: '#1a1a23', raised: '#252530' },
  light: { chat: '#fcfbfe', side: '#f2f1f7', raised: '#6b5ce0' },
  oled: { chat: '#000000', side: '#000000', raised: '#141414' },
  anime: { chat: '#130e25', side: '#18112c', raised: '#db3d87' },
  msn: { chat: '#ffffff', side: '#cddff6', raised: '#2f7bd6' },
};

export function ThemeSection() {
  const { t } = useTranslation('settings');
  const theme = useThemeStore(state => state.theme);
  const setTheme = useThemeStore(state => state.setTheme);
  const msnFrames = useThemeStore(state => state.msnFrames);
  const setMsnFrames = useThemeStore(state => state.setMsnFrames);

  return (
    <div>
      <span id="theme-label" className="block text-ui-caption font-semibold text-txt-tertiary uppercase tracking-wider mb-1.5">
        {t('theme.label')}
      </span>
      <div className="settings-section">
        <p id="theme-description" className="text-xs text-txt-tertiary mb-3">{t('theme.description')}</p>
        <div role="radiogroup" aria-labelledby="theme-label" aria-describedby="theme-description"
          className="grid grid-cols-1 desktop:grid-cols-2 gap-3">
          {THEMES.map(id => {
            const selected = theme === id;
            const swatch = SWATCHES[id];
            return (
              <button key={id} type="button" role="radio" aria-checked={selected} onClick={() => setTheme(id)}
                className={`text-left rounded-lg p-2.5 bg-wash/5 hover:bg-wash/10 transition-colors ring-2 ${selected ? 'ring-accent-primary' : 'ring-transparent'}`}>
                <span aria-hidden="true" className="flex h-12 rounded-md overflow-hidden mb-2 border border-wash/10">
                  <span className="w-1/4" style={{ background: swatch.side }} />
                  <span className="flex-1 p-1.5 flex flex-col justify-end gap-1" style={{ background: swatch.chat }}>
                    <span className="h-2 w-2/3 rounded-sm" style={{ background: swatch.raised }} />
                    <span className="h-2 w-1/2 rounded-sm" style={{ background: swatch.raised }} />
                  </span>
                </span>
                <span className="block text-sm font-medium text-txt-primary">{t(`theme.options.${id}.name`)}</span>
                <span className="block text-xs text-txt-tertiary">{t(`theme.options.${id}.description`)}</span>
              </button>
            );
          })}
        </div>
        {theme === 'msn' && (
          <div className="mt-4 flex items-center justify-between gap-3">
            <div className="min-w-0">
              <span className="block text-sm font-medium text-txt-primary">{t('theme.msnFrames.label')}</span>
              <span className="block text-xs text-txt-tertiary">{t('theme.msnFrames.description')}</span>
            </div>
            <Toggle enabled={msnFrames} onChange={setMsnFrames} ariaLabel={t('theme.msnFrames.label')} />
          </div>
        )}
      </div>
    </div>
  );
}
