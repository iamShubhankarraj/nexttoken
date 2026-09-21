/**
 * Preload for the custom Next Token PiP window. Minimal bridge:
 * frame stream in, transport (play/pause) + close out.
 */
import { contextBridge, ipcRenderer } from 'electron';

export interface NtPipApi {
  onFrame: (cb: (dataUrl: string) => void) => () => void;
  toggle: () => Promise<{ paused: boolean }>;
  close: () => Promise<void>;
}

const api: NtPipApi = {
  onFrame: (cb) => {
    const l = (_e: unknown, dataUrl: string) => {
      try {
        cb(dataUrl);
      } catch {
        /* listener must never break the stream */
      }
    };
    ipcRenderer.on('nt-pip-frame', l);
    return () => ipcRenderer.removeListener('nt-pip-frame', l);
  },
  toggle: () => ipcRenderer.invoke('nt.pip.toggle'),
  close: () => ipcRenderer.invoke('nt.pip.close'),
};

contextBridge.exposeInMainWorld('ntPip', api);
