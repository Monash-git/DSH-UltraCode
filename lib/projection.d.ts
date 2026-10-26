/** The `ultracode` session projection consumed by the composer play control. */
import type { Context } from '@deepseek-ai/cordis';
import { type SessionEvent } from '@deepseek-ai/dsh-session';
import { z } from 'zod';
import type { UltracodeProjectionState, UltracodeProjectionView } from './types.js';
import './types.js';
export declare const ultracodeProjectionDefinition: {
    key: "ultracode";
    stateSchema: z.ZodObject<{
        pause: z.ZodNullable<z.ZodObject<{
            paused: z.ZodBoolean;
            reason: z.ZodString;
            turn: z.ZodNumber;
            atSeq: z.ZodNumber;
        }, z.core.$strip>>;
        pauseStatus: z.ZodDefault<z.ZodNullable<z.ZodObject<{
            phase: z.ZodEnum<{
                pausing: "pausing";
                paused: "paused";
                resuming: "resuming";
            }>;
            acknowledged: z.ZodNumber;
            total: z.ZodNumber;
            forced: z.ZodNumber;
            warning: z.ZodOptional<z.ZodString>;
        }, z.core.$strip>>>;
        run: z.ZodNullable<z.ZodObject<{
            runId: z.ZodString;
            skill: z.ZodString;
            phase: z.ZodString;
            round: z.ZodNumber;
            maxRounds: z.ZodNumber;
        }, z.core.$strip>>;
        mode: z.ZodEnum<{
            on: "on";
            off: "off";
        }>;
    }, z.core.$strip>;
    stateVersion: number;
    init: () => UltracodeProjectionState;
    apply: (state: UltracodeProjectionState, event: SessionEvent) => UltracodeProjectionState;
    wire: {
        viewSchema: z.ZodObject<{
            paused: z.ZodBoolean;
            reason: z.ZodNullable<z.ZodString>;
            pauseStatus: z.ZodNullable<z.ZodObject<{
                phase: z.ZodEnum<{
                    pausing: "pausing";
                    paused: "paused";
                    resuming: "resuming";
                }>;
                acknowledged: z.ZodNumber;
                total: z.ZodNumber;
                forced: z.ZodNumber;
                warning: z.ZodOptional<z.ZodString>;
            }, z.core.$strip>>;
            run: z.ZodNullable<z.ZodObject<{
                runId: z.ZodString;
                skill: z.ZodString;
                phase: z.ZodString;
                round: z.ZodNumber;
                maxRounds: z.ZodNumber;
            }, z.core.$strip>>;
            mode: z.ZodEnum<{
                on: "on";
                off: "off";
            }>;
        }, z.core.$strip>;
        view: (state: UltracodeProjectionState) => UltracodeProjectionView;
    };
};
/** Register the projection when the optional registry is composed. */
export declare function registerUltracodeProjection(ctx: Context): void;
//# sourceMappingURL=projection.d.ts.map