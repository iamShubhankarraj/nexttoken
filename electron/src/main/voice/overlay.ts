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
   * Events sent before the pill page finishes loading are lost
   * (webContents.send to a not-yet-ready renderer goes nowhere), which
   * used to leave the pill stuck blank on first voice use. So show() and
   * send() queue until did-finish-load, then flush in order.
   */
  private loaded = false;
  private pendingShow = false;
  private pendingSends: Array<{ channel: string; args: unknown[] }> = [];

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
    this.loaded = false;
    this.pendingShow = false;
    this.pendingSends = [];
    win.webContents.once("did-finish-load", () => {
      if (this.win !== win || win.isDestroyed()) return;
      this.loaded = true;
      for (const p of this.pendingSends) {
        if (!win.isDestroyed()) win.webContents.send(p.channel, ...p.args);
      }
      this.pendingSends = [];
      if (this.pendingShow) {
        this.pendingShow = false;
        this.position();
        if (!win.isVisible()) win.showInactive();
      }
    });
    win.on("closed", () => {
      if (this.win === win) {
        this.win = null;
        this.loaded = false;
        this.pendingShow = false;
        this.pendingSends = [];
      }
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
    if (!this.loaded) {
      // Page still loading: remember the request; the did-finish-load
      // handler shows the window once the pill can actually render.
      this.pendingShow = true;
      return;
    }
    this.position();
    if (!w.isVisible()) w.showInactive();
  }

  hide(): void {
    this.pendingShow = false;
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

  /** Forward an event to the pill renderer (queued until the page loads). */
  send(channel: string, ...args: unknown[]): void {
    const w = this.win;
    if (!w || w.isDestroyed()) return;
    if (!this.loaded) {
      // Amplitude is ephemeral — no point replaying a stale waveform.
      if (channel === "nt:voice-amplitude") return;
      // Keep the queue small: only the latest event per channel matters.
      this.pendingSends = this.pendingSends.filter((p) => p.channel !== channel);
      this.pendingSends.push({ channel, args });
      return;
    }
    w.webContents.send(channel, ...args);
  }

  destroy(): void {
    this.win?.destroy();
    this.win = null;
  }
}
