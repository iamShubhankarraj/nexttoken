/**
 * Voice pill overlay — a floating, frameless, transparent BrowserWindow
 * that hosts the voice pill UI (renderer/components/VoicePill.tsx).
 *
 * The pill window loads the same renderer bundle as the main window but
 * with the `#voice-pill` hash, which makes main.tsx render <VoicePill/>
 * standalone instead of the full browser chrome. It subscribes to
 * `nt:voice-engine-state`, `nt:voice-amplitude`, `nt:voice-error`, and
 * `nt:voice-playback` directly over the preload bridge — no round-trip
 * through the main window needed.
 *
 * Click-through in every state except `speaking` (tap-to-interrupt
 * barge-in) and `error` (the pill may carry an action button).
 */

import { BrowserWindow, screen } from "electron";
import path from "node:path";

export type PillClickMode = "through" | "interactive";

export class VoicePillOverlay {
  private win: BrowserWindow | null = null;
  private clickMode: PillClickMode = "through";
  private getPreload: () => string;
  private getUrl: () => { url: string; isFile: boolean };

  /**
   * @param getPreload absolute path to the preload bundle
   * @param getUrl how to load the renderer: dev URL or packaged file
   */
  constructor(opts: { getPreload: () => string; getUrl: () => { url: string; isFile: boolean } }) {
    this.getPreload = opts.getPreload;
    this.getUrl = opts.getUrl;
  }

  /** Lazily create the pill window (hidden). Safe to call repeatedly. */
  ensure(): BrowserWindow {
    if (this.win && !this.win.isDestroyed()) return this.win;
    const { url, isFile } = this.getUrl();
    const win = new BrowserWindow({
      width: 340,
      height: 64,
      frame: false,
      transparent: true,
      backgroundColor: "#00000000",
      alwaysOnTop: true,
      skipTaskbar: true,
      focusable: false,
      hasShadow: false,
      resizable: false,
      movable: false,
      minimizable: false,
      maximizable: false,
      fullscreenable: false,
      show: false,
      webPreferences: {
        preload: this.getPreload(),
        contextIsolation: true,
        nodeIntegration: false,
      },
    });
    win.setIgnoreMouseEvents(true, { forward: true });
    win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
    if (isFile) void win.loadFile(url, { hash: "voice-pill" });
    else void win.loadURL(`${url}#voice-pill`);
    win.on("closed", () => {
      if (this.win === win) this.win = null;
    });
    this.win = win;
    this.position();
    return win;
  }

  /** Bottom-center of the display holding the main window, 64px above the edge. */
  position(anchor?: Electron.BrowserWindow | null): void {
    const w = this.win;
    if (!w || w.isDestroyed()) return;
    const target = anchor && !anchor.isDestroyed() ? anchor : undefined;
    const display = target
      ? screen.getDisplayMatching(target.getBounds())
      : screen.getPrimaryDisplay();
    const { width: dw, x: dx, y: dy } = display.workArea;
    const [pw, ph] = w.getSize();
    w.setPosition(Math.round(dx + (dw - pw) / 2), Math.round(dy + display.workArea.height - ph - 64));
  }

  show(): void {
    const w = this.ensure();
    this.position();
    if (!w.isVisible()) w.showInactive();
  }

  hide(): void {
    this.win?.hide();
  }

  get visible(): boolean {
    return !!this.win && !this.win.isDestroyed() && this.win.isVisible();
  }

  /** Speaking/error states accept clicks (barge-in); everything else is click-through. */
  setClickMode(mode: PillClickMode): void {
    if (mode === this.clickMode) return;
    this.clickMode = mode;
    this.win?.setIgnoreMouseEvents(mode === "through", { forward: true });
  }

  /** Forward an event to the pill renderer. */
  send(channel: string, ...args: unknown[]): void {
    const w = this.win;
    if (w && !w.isDestroyed()) w.webContents.send(channel, ...args);
  }

  destroy(): void {
    this.win?.destroy();
    this.win = null;
  }
}
