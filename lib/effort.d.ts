/**
 * Add the selector-level Ultra tier to DeepSeek models without patching DSH.
 *
 * The tier is persisted as `ultra` in the session selection, while every
 * provider request is mapped back to `max`, the highest wire effort DeepSeek
 * supports. Only models that already advertise `max` are decorated.
 */
import type { Context } from '@deepseek-ai/cordis';
/** Install the decoration once the optional LLM service is active. */
export declare function registerUltraEffort(ctx: Context): void;
/** Install the Ultra effort decoration; returns a disposer that restores the service. */
export declare function installUltraEffort(ctx: Context): () => void;
//# sourceMappingURL=effort.d.ts.map