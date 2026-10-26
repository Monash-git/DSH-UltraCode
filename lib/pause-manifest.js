/** Shared mutation and warning folding for the durable pause manifest. */
/**
 * Apply a patch to one child. Optional fields are deleted rather than assigned
 * `undefined`: plugin records reject any non-JSON value, including explicit
 * undefined.
 */
export function applyChildPatch(child, patch) {
    const next = { ...child };
    for (const [key, value] of Object.entries(patch)) {
        if (value === undefined)
            delete next[key];
        else
            next[key] = value;
    }
    return next;
}
/** Patch one child in the manifest and refresh the derivative forced count. */
export function patchManifestChild(manifest, childId, patch) {
    manifest.children = manifest.children.map(child => child.id === childId ? applyChildPatch(child, patch) : child);
    manifest.forced = manifest.children.filter(child => child.forced === true).length;
}
/** Every visible warning carried by the manifest. */
export function manifestWarnings(manifest) {
    return [
        ...(manifest.restoredWarning === undefined ? [] : [manifest.restoredWarning]),
        ...manifest.children.map(child => child.warning),
        ...manifest.jobs.map(job => job.warning),
        ...(manifest.workflows ?? []).map(workflow => workflow.warning),
    ].filter((value) => value !== undefined && value !== '');
}
/** Recompute the single manifest warning from children, jobs, and workflows. */
export function refreshManifestWarning(manifest, extra = []) {
    const unique = [...new Set([...manifestWarnings(manifest), ...extra])];
    if (unique.length === 0)
        delete manifest.warning;
    else
        manifest.warning = unique.join(' ');
}
//# sourceMappingURL=pause-manifest.js.map