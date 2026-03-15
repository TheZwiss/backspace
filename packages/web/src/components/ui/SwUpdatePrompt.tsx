import { useRegisterSW } from 'virtual:pwa-register/react';
import { useEffect } from 'react';
import { isElectron } from '../../platform/platform';

export function SwAutoUpdate() {
  const inElectron = isElectron();

  useRegisterSW({
    onRegisteredSW(_swUrl, registration) {
      if (!registration || inElectron) return;
      setInterval(() => {
        registration.update();
      }, 60_000);
    },
  });

  useEffect(() => {
    if (inElectron) return;
    if (!navigator.serviceWorker) return;
    const onControllerChange = () => window.location.reload();
    navigator.serviceWorker.addEventListener('controllerchange', onControllerChange);
    return () => navigator.serviceWorker.removeEventListener('controllerchange', onControllerChange);
  }, [inElectron]);

  return null;
}
