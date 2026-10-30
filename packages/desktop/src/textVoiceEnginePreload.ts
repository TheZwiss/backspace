import { contextBridge, ipcRenderer } from 'electron';
contextBridge.exposeInMainWorld('localTextVoiceEngine', {
  onRequest: (callback: (operation: string, data: unknown) => Promise<unknown>) => {
    ipcRenderer.on('local-tts-request', async (_event, id: number, operation: string, data: unknown) => {
      try { ipcRenderer.send('local-tts-result', id, { ok: true, result: await callback(operation, data) }); }
      catch (error) { ipcRenderer.send('local-tts-result', id, { ok: false, error: error instanceof Error ? error.message : 'engine-failed' }); }
    });
    ipcRenderer.send('local-tts-ready');
  },
});
