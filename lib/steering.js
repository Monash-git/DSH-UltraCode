/**
 * One-time busy-enter default: an unset `ui-conversation.busyEnter` becomes
 * `steer`, so a message sent during tool calls reaches the next model call
 * instead of waiting for the next turn. An explicit user choice is preserved.
 */
const NAMESPACE = 'ui-conversation';
const FIELD = 'busyEnter';
/** Install the one-time default; returns a disposer for the optional child. */
export function installBusyEnterDefault(ctx, config) {
    if (config.busyEnterDefault === 'preserve')
        return () => { };
    let off;
    let applied = false;
    let pending = false;
    const attempt = (settings) => {
        if (applied || pending)
            return;
        const row = settings.describe().find(candidate => candidate.ns === NAMESPACE);
        if (row === undefined)
            return;
        const user = row.user ?? {};
        if (Object.hasOwn(user, FIELD)) {
            applied = true;
            return;
        }
        const current = row.value?.[FIELD];
        if (config.busyEnterDefault === 'queue' && current === 'queue') {
            applied = true;
            return;
        }
        pending = true;
        void Promise.resolve(settings.update(NAMESPACE, { [FIELD]: config.busyEnterDefault }, row.revision))
            .then(() => { applied = true; })
            .catch((error) => {
            console.error('[dsh-ultracode] unable to set the default busy-enter behavior:', error);
        })
            .finally(() => { pending = false; });
    };
    const fiber = ctx.inject(['settings'], scoped => {
        const settings = scoped.settings;
        attempt(settings);
        off = scoped.on('settings/document-updated', (() => {
            attempt(settings);
        }));
    });
    return () => {
        off?.();
        void Promise.resolve(fiber).then(child => child.dispose()).catch(() => { });
    };
}
//# sourceMappingURL=steering.js.map