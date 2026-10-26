/** Shared mutation and warning folding for the durable pause manifest. */
import type { PauseChildState, PauseManifestChild, PauseManifestEvent } from './types.js';
/** One child patch; `undefined` deletes the field instead of storing null. */
export type PauseChildPatch = Partial<PauseManifestChild> & {
    readonly state: PauseChildState;
};
/**
 * Apply a patch to one child. Optional fields are deleted rather than assigned
 * `undefined`: plugin records reject any non-JSON value, including explicit
 * undefined.
 */
export declare function applyChildPatch(child: PauseManifestChild, patch: PauseChildPatch): PauseManifestChild;
/** Patch one child in the manifest and refresh the derivative forced count. */
export declare function patchManifestChild(manifest: PauseManifestEvent, childId: string, patch: PauseChildPatch): void;
/** Every visible warning carried by the manifest. */
export declare function manifestWarnings(manifest: PauseManifestEvent): string[];
/** Recompute the single manifest warning from children, jobs, and workflows. */
export declare function refreshManifestWarning(manifest: PauseManifestEvent, extra?: readonly string[]): void;
//# sourceMappingURL=pause-manifest.d.ts.map