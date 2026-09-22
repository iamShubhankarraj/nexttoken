/**
 * settingsNav — cross-component Settings navigation (v0.6.3, impl-5).
 *
 * DownloadPill and PrivacyAdvanced live outside the Settings overlay but
 * need to open it on a specific section ("All downloads", "Open history
 * manager"). Opening is async (round-trip through main), so a plain event
 * could fire before Settings mounts — this module stashes the request and
 * Settings consumes it on mount, then listens for in-flight jumps.
 */

export const SETTINGS_SECTION_EVENT = "nt:settings-section";

let pending: string | null = null;

/** Ask Settings to open on `section` (consumed on mount, or live). */
export function requestSettingsSection(section: string): void {
  pending = section;
  window.dispatchEvent(new CustomEvent(SETTINGS_SECTION_EVENT, { detail: section }));
}

/** Take the stashed section request, if any. */
export function consumePendingSettingsSection(): string | null {
  const s = pending;
  pending = null;
  return s;
}
