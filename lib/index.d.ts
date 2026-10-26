/**
 * DSH Ultracode host plugin: selector-level Ultra, standing playbook/reminders,
 * skill autopilot, steer-aware continuation, and pause/resume for root sessions.
 *
 * All model-visible additions are appended user messages. The plugin never
 * changes the system prompt, tool declarations, provider, model, or wire effort.
 */
import type { Context } from '@deepseek-ai/cordis';
import { type PluginConfig } from './config.js';
export declare const name = "dsh-ultracode";
export declare const inject: string[];
/** Plugin entry: effort decoration, Ultra standing mode, autopilot, pause/resume. */
export declare function apply(ctx: Context, config?: PluginConfig): void;
//# sourceMappingURL=index.d.ts.map