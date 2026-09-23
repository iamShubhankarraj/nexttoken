/**
 * touchid.ts — macOS biometric confirmation for sensitive actions.
 *
 * promptTouchID resolves only when the user's fingerprint (or, where
 * configured, the device passcode via the same sheet) verifies. It is a UX
 * gate, not crypto: callers must still enforce the decision — never hand
 * back the secret unless this resolves 'confirmed'.
 *
 * Falls back to 'unavailable' on non-macOS or machines without Touch ID;
 * callers then use their existing approval dialog so nothing is lost.
 * The promise rejects on user cancel/failure — mapped to 'denied'.
 */
import { systemPreferences } from 'electron';

export type TouchIdResult = 'confirmed' | 'denied' | 'unavailable';

export async function confirmWithTouchId(reason: string): Promise<TouchIdResult> {
  if (process.platform !== 'darwin') return 'unavailable';
  try {
    if (!systemPreferences.canPromptTouchID()) return 'unavailable';
    await systemPreferences.promptTouchID(reason);
    return 'confirmed';
  } catch {
    // User cancelled, or the policy evaluation failed — treat as denial.
    return 'denied';
  }
}
