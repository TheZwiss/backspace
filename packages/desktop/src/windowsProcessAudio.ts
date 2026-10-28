import { spawn, type ChildProcessWithoutNullStreams } from 'child_process';

/** A helper owns exactly one WASAPI process-tree capture. PCM is 48kHz stereo s16le. */
export class WindowsProcessAudio {
  private child: ChildProcessWithoutNullStreams | null = null;
  constructor(private readonly executable: string, private readonly onData: (data: Buffer) => void, private readonly onEnded: () => void) {}
  stop(): void { const child = this.child; this.child = null; child?.kill(); }
  async start(sourceId: string, appPid: number): Promise<boolean> {
    this.stop();
    const match = /^window:(\d+):\d+$/.exec(sourceId);
    if (!match && !/^screen:/.test(sourceId)) return false;
    const child = spawn(this.executable, match ? ['window', match[1]!] : ['exclude', String(appPid)], { windowsHide: true });
    this.child = child;
    return new Promise((resolve) => {
      let ready = false;
      let settled = false;
      const timer = setTimeout(() => finish(false), 12000);
      const finish = (ok: boolean) => {
        if (settled) return;
        settled = true; clearTimeout(timer);
        if (!ok && this.child === child) this.stop();
        resolve(ok);
      };
      let status = '';
      child.stderr.on('data', (data: Buffer) => {
        status = (status + data.toString()).slice(-1024);
        if (status.includes('READY\n') && this.child === child) { ready = true; finish(true); }
      });
      let remainder = Buffer.alloc(0);
      child.stdout.on('data', (data: Buffer) => {
        if (!ready || this.child !== child) return;
        const bytes = Buffer.concat([remainder, data]);
        const length = bytes.length - bytes.length % 4;
        if (length) this.onData(bytes.subarray(0, length));
        remainder = Buffer.from(bytes.subarray(length));
      });
      child.on('error', () => finish(false));
      child.on('exit', () => {
        finish(false);
        if (this.child === child) { this.child = null; if (ready) this.onEnded(); }
      });
    });
  }
}
