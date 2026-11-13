import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { DiskPressureStatus, InstanceAdminSettings } from '@backspace/shared';
import { DiskCleanupSection, diskDraftProblem } from './DiskCleanupSection';
import { useSettingsStore } from '../../../stores/settingsStore';
import { api } from '../../../api/client';

const GB = 1024 ** 3;

function settings(patch: Partial<InstanceAdminSettings> = {}): InstanceAdminSettings {
  return {
    diskCleanupEnabled: false,
    diskCleanupThresholdPercent: 90,
    diskCleanupTargetPercent: 80,
    diskCleanupMinAgeDays: 30,
    ...patch,
  } as InstanceAdminSettings;
}

function status(patch: Partial<DiskPressureStatus> = {}): DiskPressureStatus {
  return {
    enabled: false,
    usedPercent: 42.5,
    totalBytes: 100 * GB,
    usedBytes: 42.5 * GB,
    thresholdPercent: 90,
    targetPercent: 80,
    minAgeDays: 30,
    checkIntervalMinutes: 15,
    lastRun: null,
    ...patch,
  };
}

const updateInstanceSettings = vi.fn();

beforeEach(() => {
  vi.restoreAllMocks();
  updateInstanceSettings.mockReset().mockResolvedValue(undefined);
  useSettingsStore.setState({ instanceSettings: settings(), updateInstanceSettings } as never);
  vi.spyOn(api.admin, 'diskStatus').mockResolvedValue(status());
});

describe('diskDraftProblem', () => {
  const ok = { threshold: '90', target: '80', age: '30' };

  it('accepts what the server accepts', () => {
    expect(diskDraftProblem(ok)).toBeNull();
    expect(diskDraftProblem({ threshold: '50', target: '10', age: '1' })).toBeNull();
    expect(diskDraftProblem({ threshold: '99', target: '94', age: '3650' })).toBeNull();
  });

  it('names the first bad field', () => {
    expect(diskDraftProblem({ ...ok, threshold: '49' })).toBe('threshold');
    expect(diskDraftProblem({ ...ok, threshold: '' })).toBe('threshold');
    expect(diskDraftProblem({ ...ok, threshold: '85.5' })).toBe('threshold');
    expect(diskDraftProblem({ ...ok, target: '86' })).toBe('target');
    expect(diskDraftProblem({ ...ok, target: '9' })).toBe('target');
    expect(diskDraftProblem({ ...ok, age: '0' })).toBe('age');
    expect(diskDraftProblem({ ...ok, age: '3651' })).toBe('age');
  });

  it('judges the target against the threshold being typed', () => {
    expect(diskDraftProblem({ threshold: '70', target: '66', age: '30' })).toBe('target');
    expect(diskDraftProblem({ threshold: '70', target: '65', age: '30' })).toBeNull();
  });
});

describe('DiskCleanupSection', () => {
  it('shows the live disk usage and the saved limits', async () => {
    render(<DiskCleanupSection />);
    expect(await screen.findByText(/42\.5% of the disk used/)).toBeInTheDocument();
    expect(screen.getByRole('progressbar')).toHaveAttribute('aria-valuenow', '43');
    expect(screen.getByDisplayValue('90')).toBeInTheDocument();
    expect(screen.getByDisplayValue('80')).toBeInTheDocument();
    expect(screen.getByDisplayValue('30')).toBeInTheDocument();
    expect(screen.getByText('No cleanup has run yet.')).toBeInTheDocument();
  });

  it('is off until the owner turns it on, and turning it on goes through the settings', async () => {
    render(<DiskCleanupSection />);
    const toggle = await screen.findByRole('switch');
    expect(toggle).toHaveAttribute('aria-checked', 'false');
    expect(screen.queryByText(/can be deleted for good/)).not.toBeInTheDocument();

    await userEvent.click(toggle);
    expect(updateInstanceSettings).toHaveBeenCalledWith({ diskCleanupEnabled: true });
  });

  it('warns about deletion, with the age floor, while it is on', async () => {
    useSettingsStore.setState({ instanceSettings: settings({ diskCleanupEnabled: true, diskCleanupMinAgeDays: 14 }) } as never);
    render(<DiskCleanupSection />);
    expect(await screen.findByText(/older than 14 days can be deleted for good/)).toBeInTheDocument();
  });

  it('keeps Save off until something changed, and sends all three numbers', async () => {
    render(<DiskCleanupSection />);
    await screen.findByText(/of the disk used/);
    const save = screen.getByRole('button', { name: 'Save' });
    expect(save).toBeDisabled();

    const age = screen.getByDisplayValue('30');
    await userEvent.clear(age);
    await userEvent.type(age, '60');
    expect(save).toBeEnabled();
    await userEvent.click(save);
    expect(updateInstanceSettings).toHaveBeenCalledWith({
      diskCleanupThresholdPercent: 90,
      diskCleanupTargetPercent: 80,
      diskCleanupMinAgeDays: 60,
    });
  });

  it('explains a bad value and refuses to save it', async () => {
    render(<DiskCleanupSection />);
    await screen.findByText(/of the disk used/);
    const target = screen.getByDisplayValue('80');
    await userEvent.clear(target);
    await userEvent.type(target, '88');
    expect(await screen.findByText(/must be a whole number between 10 and 85/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Save' })).toBeDisabled();
  });

  it('checks now only while on and with nothing unsaved, and says when there was nothing to do', async () => {
    useSettingsStore.setState({ instanceSettings: settings({ diskCleanupEnabled: true }) } as never);
    const sweep = vi.spyOn(api.admin, 'diskSweep').mockResolvedValue({ run: null, status: status({ enabled: true }) });
    render(<DiskCleanupSection />);
    await screen.findByText(/of the disk used/);
    await userEvent.click(screen.getByRole('button', { name: 'Check now' }));
    expect(sweep).toHaveBeenCalledTimes(1);
    expect(await screen.findByText('The disk is under the limit, so nothing was deleted.')).toBeInTheDocument();
  });

  it('keeps Check now off while the feature is off', async () => {
    render(<DiskCleanupSection />);
    await screen.findByText(/of the disk used/);
    expect(screen.getByRole('button', { name: 'Check now' })).toBeDisabled();
  });

  it('describes the last sweep', async () => {
    vi.spyOn(api.admin, 'diskStatus').mockResolvedValue(status({
      enabled: true,
      usedPercent: 91.2,
      lastRun: { at: 1_700_000_000_000, usedPercentBefore: 93.1, usedPercentAfter: 79.4, stage: 'media', deletedFiles: 12, freedBytes: 5 * GB, errors: [] },
    }));
    render(<DiskCleanupSection />);
    await waitFor(() => expect(screen.getByText(/including old attachments/)).toBeInTheDocument());
    expect(screen.getByText(/93\.1% → 79\.4%, 12 file\(s\) deleted, 5(\.0)? GB freed/)).toBeInTheDocument();
  });

  it('says so when the disk cannot be read', async () => {
    vi.spyOn(api.admin, 'diskStatus').mockResolvedValue(status({ usedPercent: null, totalBytes: null, usedBytes: null }));
    render(<DiskCleanupSection />);
    expect(await screen.findByText('The disk usage could not be read.')).toBeInTheDocument();
  });
});
