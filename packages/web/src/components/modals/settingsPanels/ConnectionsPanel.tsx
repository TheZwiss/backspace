import { ConnectedInstances } from '../ConnectedInstances';

export function ConnectionsPanel() {
  return (
    <div className="space-y-5">
      <h2 className="text-lg font-semibold text-txt-primary mb-6">Connections</h2>
      <ConnectedInstances />
    </div>
  );
}
