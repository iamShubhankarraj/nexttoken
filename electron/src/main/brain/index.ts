/**
 * The Next Token brain — System-One/System-Two orchestration.
 *
 * - jev.ts: typed client for Jev (TypeSafe AI), the System One decision model.
 * - voice-commands.ts: the 100%-voice-control command map + local fallback classifier.
 * - orchestrator.ts: the pipeline — classify -> gate -> safety -> dispatch -> speak.
 *
 * Wiring into the app happens per docs/brain-wiring-plan.md (applied after
 * the UI rebuild merges). Until then these modules are standalone and import
 * only existing, stable modules.
 */

export * from './jev';
export * from './credentials';
export * from './voice-commands';
export * from './orchestrator';
