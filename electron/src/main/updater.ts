/**
 * In-app update plumbing (electron-updater, generic provider).
 *
 * Update-in-place guarantee: the packaged app is always "Next Token.app"
 * with the single stable CFBundleIdentifier `com.nexttoken.app`
 * (electron-builder.yml `appId`). Replacing the old .app in /Applications
 * IS the update — macOS never sees a second app identity.
 *
 * electron-updater is scaffolded here so future releases can update
 * in-app. Until a release feed URL is configured (electron-builder.yml
 * `publish`), "Check for updates" degrades gracefully to a dialog —
 * nothing throws, nothing phones home.
 */
import { app, dialog } from 'electron';
import { autoUpdater } from 'electron-updater';

let wired = false;

export function setupUpdater(): void {
  if (wired) return;
  wired = true;

  autoUpdater.autoDownload = false;
  autoUpdater.autoInstallOnAppQuit = true;

  autoUpdater.on('update-available', (info) => {
    const win = undefined;
    void dialog
      .showMessageBox({
        type: 'info',
        title: 'Update available',
        message: `Next Token ${info.version} is available.`,
        detail: 'Download it now? The app will install the update on quit.',
        buttons: ['Download update', 'Later'],
        defaultId: 0,
        cancelId: 1,
      })
      .then(({ response }) => {
        if (response === 0) void autoUpdater.downloadUpdate();
      });
  });

  autoUpdater.on('update-downloaded', () => {
    void dialog
      .showMessageBox({
        type: 'info',
        title: 'Update ready',
        message: 'The update has been downloaded.',
        detail: 'Restart Next Token to install it.',
        buttons: ['Restart now', 'Later'],
        defaultId: 0,
        cancelId: 1,
      })
      .then(({ response }) => {
        if (response === 0) autoUpdater.quitAndInstall();
      });
  });

  autoUpdater.on('update-not-available', () => {
    void dialog.showMessageBox({
      type: 'info',
      title: 'No updates',
      message: `You're on the latest version (${app.getVersion()}).`,
      buttons: ['OK'],
    });
  });

  autoUpdater.on('error', (err) => {
    // Never surface raw updater internals; the feed simply may not exist yet.
    void dialog.showMessageBox({
      type: 'info',
      title: 'Could not check for updates',
      message: 'Automatic updates are not set up for this build yet.',
      detail: 'Download new versions from the Next Token website. (Update check failed.)',
      buttons: ['OK'],
    });
    void err;
  });
}

/**
 * Manual "Check for updates" entry point (menu item / IPC).
 * Degrades gracefully when no release feed is configured.
 */
export async function checkForUpdatesManually(): Promise<void> {
  setupUpdater();
  try {
    // With no publish feed configured this rejects → graceful dialog below.
    // With a feed, the update-available / update-not-available / error
    // events drive the dialogs.
    await autoUpdater.checkForUpdates();
  } catch {
    // No feed configured (or unreachable): graceful dialog, never a throw.
    await dialog.showMessageBox({
      type: 'info',
      title: 'Could not check for updates',
      message: 'Automatic updates are not set up for this build yet.',
      detail: 'Download new versions from the Next Token website.',
      buttons: ['OK'],
    });
  }
}
