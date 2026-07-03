import { useRegisterSW } from 'virtual:pwa-register/react';
import { useEffect } from 'react';

export function SwAutoUpdate() {
  useRegisterSW({
    onRegisteredSW(_swUrl, registration) {
      if (!registration) return;
      setInterval(() => {
        registration.update();
      }, 60_000);
    },
  });

  useEffect(() => {
    if (!navigator.serviceWorker) return;
    const onControllerChange = () => window.location.reload();
    navigator.serviceWorker.addEventListener('controllerchange', onControllerChange);
    return () => navigator.serviceWorker.removeEventListener('controllerchange', onControllerChange);
  }, []);

  return null;
}
