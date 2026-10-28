import { EventEmitter } from 'events';
import { describe, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({ spawn: vi.fn() }));
vi.mock('child_process', () => ({ spawn: mocks.spawn }));
import { WindowsProcessAudio } from './windowsProcessAudio';
function child() {
  return Object.assign(new EventEmitter(), { stdout: new EventEmitter(), stderr: new EventEmitter(), kill: vi.fn() });
}
describe('Windows process audio capture', () => {
  it('includes a selected window, preserves stereo sample boundaries and stops the helper', async () => {
    const process = child(); mocks.spawn.mockReturnValue(process);
    const data = vi.fn(); const capture = new WindowsProcessAudio('capture.exe', data, vi.fn());
    const started = capture.start('window:123456:0', 99);
    process.stderr.emit('data', Buffer.from('READY\n'));
    expect(await started).toBe(true);
    expect(mocks.spawn).toHaveBeenLastCalledWith('capture.exe', ['window', '123456'], { windowsHide: true });
    process.stdout.emit('data', Buffer.from([1, 2, 3]));
    expect(data).not.toHaveBeenCalled();
    process.stdout.emit('data', Buffer.from([4, 5, 6, 7, 8]));
    expect([...data.mock.calls[0]![0]]).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
    capture.stop(); expect(process.kill).toHaveBeenCalledOnce();
  });
  it('excludes the entire app process tree for a screen and rejects unavailable capture', async () => {
    const process = child(); mocks.spawn.mockReturnValue(process);
    const capture = new WindowsProcessAudio('capture.exe', vi.fn(), vi.fn());
    const started = capture.start('screen:0:0', 99);
    expect(mocks.spawn).toHaveBeenLastCalledWith('capture.exe', ['exclude', '99'], { windowsHide: true });
    process.emit('error', new Error('missing helper'));
    expect(await started).toBe(false);
    expect(await capture.start('bad-source', 99)).toBe(false);
  });
});
