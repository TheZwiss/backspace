import { describe, it, expect, afterEach } from 'vitest';
import { render, cleanup } from '@testing-library/react';
import { AppearancePanel } from './AppearancePanel';

afterEach(cleanup);

describe('AppearancePanel', () => {
  // Both controls are stored per device and work on the login screen, which is
  // why they live here rather than with the account-owned settings.
  it('carries the language and interface scale controls', () => {
    const { container } = render(<AppearancePanel />);
    expect(container.querySelector('#language-select')).not.toBeNull();
    expect(container.querySelector('#interface-scale')).not.toBeNull();
  });
});
