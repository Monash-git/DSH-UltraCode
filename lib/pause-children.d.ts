/** Child lineage, checkpoints, stops, and acknowledgment waits for pause. */
import type { Agent } from '@deepseek-ai/dsh-agent';
import type { Session } from '@deepseek-ai/dsh-session';
import type { ParkAcknowledgement, ParkEntry } from './park.js';
/** The subset of the live agent registry used for lineage discovery. */
export interface LiveAgentRegistryLike {
    list(): readonly Agent[];
    get(id: Agent['id']): Agent | undefined;
}
/** The optional interrupt surface used to stop a child that will not park. */
export interface ChildStopServiceLike {
    interrupt?(targetSessionId: Agent['session']['id'], authority: {
        readonly kind: 'ancestor';
        readonly agent: Agent;
    }): void;
}
/** Live descendants by durable lineage (`origin: subagent`), direct or deeper. */
export declare function liveChildren(root: Agent, registry: LiveAgentRegistryLike | undefined): Agent[];
/** One live descendant by durable id, if still resident. */
export declare function liveChild(root: Agent, childId: string, registry: LiveAgentRegistryLike | undefined): Agent | undefined;
/**
 * Stop one child through the existing interrupt path. Used when a child will
 * not reach its park point or when a cancelled pause must not keep old work.
 */
export declare function stopChild(root: Agent, child: Agent, service: ChildStopServiceLike | undefined): void;
/**
 * Flush, capture the durable checkpoint, and return its acknowledgment. The
 * checkpoint includes the current task, todo list, last assistant text, and
 * bounded artifact paths the session presented.
 */
export declare function checkpointAgent(agent: Agent, pauseId: string, turn: number, step: number, forced: boolean, root: boolean, flush: (session: Session) => Promise<void>): Promise<ParkAcknowledgement>;
/** Wait until every park request acknowledges, or the bounded timeout ends. */
export declare function waitForAcknowledgements(entries: ReadonlyMap<string, ParkEntry>, timeoutMs: number): Promise<void>;
//# sourceMappingURL=pause-children.d.ts.map