import { useTranslation } from 'react-i18next';
import { INTERFACE_SCALES, useInterfaceScaleStore } from '../../../stores/interfaceScaleStore';
import { useUIStore } from '../../../stores/uiStore';

export function InterfaceScaleSection() {
  const { t } = useTranslation('settings');
  const scale = useInterfaceScaleStore(state => state.scale);
  const setScale = useInterfaceScaleStore(state => state.setScale);
  const changeScale = (value: number) => {
    const wasMobile = useUIStore.getState().isMobile;
    setScale(value);
    const ui = useUIStore.getState();
    // Keep settings reachable when scaling crosses the responsive breakpoint.
    if (ui.isMobile !== wasMobile) {
      if (ui.isMobile) {
        ui.closeModal();
        ui.pushMobileScreen('settings-account');
      } else {
        ui.openModal('userSettings', { tab: 'account' });
      }
    }
  };
  return (
    <div>
      <label htmlFor="interface-scale" className="block text-[11px] font-semibold text-txt-tertiary uppercase tracking-wider mb-1.5">
        {t('interfaceScale.label')}
      </label>
      <div className="rounded-lg bg-white/[0.03] border border-white/[0.04] p-3.5">
        <p id="interface-scale-description" className="text-xs text-txt-tertiary mb-2">{t('interfaceScale.description')}</p>
        <div className="flex flex-wrap gap-2">
          <select id="interface-scale" aria-describedby="interface-scale-description" value={scale}
            onChange={event => changeScale(Number(event.target.value))} className="input-standard flex-1 min-w-0">
            {INTERFACE_SCALES.map(value => <option key={value} value={value}>{value}%</option>)}
          </select>
          <button type="button" onClick={() => changeScale(100)} disabled={scale === 100}
            className="px-3 py-2 rounded-md bg-white/5 hover:bg-white/10 text-sm text-txt-primary disabled:opacity-50">{t('interfaceScale.reset')}</button>
        </div>
      </div>
    </div>
  );
}
