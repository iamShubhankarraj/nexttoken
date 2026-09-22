/**
 * ipcGuard.ts — every renderer→main IPC channel goes through here.
 *
 * Only the app's own windows (the shell window, the PiP window) may invoke
 * nt.* channels. Guest <webview> contents have no preload bridge and must
 * never reach main-process handlers — this allowlist is defense-in-depth
 * for that boundary. Untrusted senders get a thrown error (invoke) or a
 * silent drop (on), plus a console warning so abuse is visible in logs.
 *
 * NOTE: the adblocker's own content-script channels (registered inside
 * adblock/index.ts) are intentionally NOT guarded — @cliqz/adblocker-electron
 * requires its guest content scripts to reach those handlers by design.
 */
import { ipcMain } from 'electron';
import type { IpcMainEvent, IpcMainInvokeEvent } from 'electron';

const allowedSenders = new Set<number>();

/** Register a window's webContents as a legitimate IPC sender. */
export function allowIpcSender(webContentsId: number): void {
  allowedSenders.add(webContentsId);
}

/** Drop a registration when its window closes (webContents ids can be recycled). */
export function revokeIpcSender(webContentsId: number): void {
  allowedSenders.delete(webContentsId);
}

function senderAllowed(senderId: number): boolean {
  return allowedSenders.has(senderId);
}

export function guardedHandle(
  channel: string,
  listener: (event: IpcMainInvokeEvent, ...args: any[]) => unknown
): void {
  ipcMain.handle(channel, (event, ...args) => {
    if (!senderAllowed(event.sender.id)) {
      console.warn(
        `[security] blocked IPC '${channel}' from untrusted sender (webContents ${event.sender.id})`
      );
      throw new Error(`IPC channel '${channel}' is not available to this sender.`);
    }
    return listener(event, ...args);
  });
}

export function guardedOn(
  channel: string,
  listener: (event: IpcMainEvent, ...args: any[]) => void
): void {
  ipcMain.on(channel, (event, ...args) => {
    if (!senderAllowed(event.sender.id)) {
      console.warn(
        `[security] blocked IPC '${channel}' from untrusted sender (webContents ${event.sender.id})`
      );
      return;
    }
    listener(event, ...args);
  });
}
