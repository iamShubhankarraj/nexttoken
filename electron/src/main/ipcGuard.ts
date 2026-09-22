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

/**
 * Payload shape guard: a compromised renderer must not be able to hand main
 * a multi-GB string, a 10 000-deep object (stack overflow in recursive
 * handlers), or exotic values IPC can't faithfully carry anyway.
 * Returns the approximate byte size, or -1 when the payload is rejected.
 */
const MAX_IPC_DEPTH = 25;
const MAX_IPC_BYTES = 8 * 1024 * 1024; // ~8 MB total per call

function payloadByteSize(args: unknown[]): number {
  let size = 0;
  const seen = new Set<object>();
  const stack: Array<{ v: unknown; depth: number }> = args.map((v) => ({ v, depth: 0 }));
  while (stack.length > 0) {
    const { v, depth } = stack.pop()!;
    if (depth > MAX_IPC_DEPTH) return -1;
    if (v === null || v === undefined) {
      size += 4;
      continue;
    }
    switch (typeof v) {
      case 'string':
        size += v.length * 2; // approx UTF-16
        break;
      case 'number':
      case 'boolean':
        size += 8;
        break;
      case 'bigint':
      case 'function':
      case 'symbol':
        return -1; // not IPC-serializable — reject
      case 'object': {
        if (seen.has(v)) continue; // cycles clone fine; don't double-count
        seen.add(v);
        // Binary blobs are opaque — count bytes, don't walk "indices".
        if (v instanceof ArrayBuffer) {
          size += v.byteLength;
          break;
        }
        if (ArrayBuffer.isView(v)) {
          size += (v as ArrayBufferView).byteLength;
          break;
        }
        size += 32;
        const rec = v as Record<string, unknown>;
        for (const k of Object.keys(rec)) {
          size += k.length * 2;
          stack.push({ v: rec[k], depth: depth + 1 });
        }
        break;
      }
      default:
        return -1;
    }
    if (size > MAX_IPC_BYTES) return -1;
  }
  return size;
}

function payloadAllowed(channel: string, args: unknown[]): boolean {
  if (payloadByteSize(args) < 0) {
    console.warn(`[security] blocked IPC '${channel}': oversized or malformed payload`);
    return false;
  }
  return true;
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
    if (!payloadAllowed(channel, args)) {
      throw new Error(`IPC channel '${channel}': payload rejected.`);
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
    if (!payloadAllowed(channel, args)) return;
    listener(event, ...args);
  });
}
