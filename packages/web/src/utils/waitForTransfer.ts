import { useTransferStore } from '../stores/transferStore';

export interface TransferAttachmentRef {
  attachmentId: string;
  filename: string;
}

/**
 * Wait for a transferStore upload to reach a terminal state.
 * Resolves with the server-assigned attachmentId + filename on success.
 * Rejects on failure or abort.
 *
 * Handles the already-terminal case synchronously (resolves/rejects immediately
 * without subscribing) and unsubscribes after the first terminal observation.
 */
export function waitForTransferAttachment(transferId: string): Promise<TransferAttachmentRef> {
  return new Promise<TransferAttachmentRef>((resolve, reject) => {
    const check = (): boolean => {
      const t = useTransferStore.getState().transfers.get(transferId);
      if (!t) return false;
      if (t.state === 'completed' && t.attachmentId && t.attachmentFilename) {
        resolve({ attachmentId: t.attachmentId, filename: t.attachmentFilename });
        return true;
      }
      if (t.state === 'failed' || t.state === 'aborted') {
        reject(new Error(t.error?.message ?? 'Upload failed'));
        return true;
      }
      return false;
    };

    if (check()) return;

    const unsub = useTransferStore.subscribe(() => {
      if (check()) unsub();
    });
  });
}
