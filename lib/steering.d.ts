/**
 * One-time busy-enter default: an unset `ui-conversation.busyEnter` becomes
 * `steer`, so a message sent during tool calls reaches the next model call
 * instead of waiting for the next turn. An explicit user choice is preserved.
 */
import type { Context } from '@deepseek-ai/cordis';
import type { ResolvedConfig } from './config.js';
/** Install the one-time default; returns a disposer for the optional child. */
export declare function installBusyEnterDefault(ctx: Context, config: ResolvedConfig): () => void;
//# sourceMappingURL=steering.d.ts.map