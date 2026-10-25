/** Child lineage, checkpoints, stops, and acknowledgment waits for pause. */

import type { Agent } from '@deepseek-ai/dsh-agent'
import type { Session } from '@deepseek-ai/dsh-session'
import type { ParkAcknowledgement, ParkEntry } from './park.js'
import {
  appendCheckpointEvent,
  lastSeq,
  latestArtifactPaths,
  latestAssistantText,
  latestTodos,
} from './state.js'

/** The subset of the live agent registry used for lineage discovery. */
export interface LiveAgentRegistryLike {
  list(): readonly Agent[]
  get(id: Agent['id']): Agent | undefined
}

/** The optional interrupt surface used to stop a child that will not park. */
export interface ChildStopServiceLike {
  interrupt?(
    targetSessionId: Agent['session']['id'],
    authority: { readonly kind: 'ancestor'; readonly agent: Agent },
  ): void
}

/** Live descendants by durable lineage (`origin: subagent`), direct or deeper. */
export function liveChildren(
  root: Agent,
  registry: LiveAgentRegistryLike | undefined,
): Agent[] {
  if (registry === undefined) return []
  const byParent = new Map<string, Agent[]>()
  for (const agent of registry.list()) {
    const { parentSession, origin } = agent.session.header
    if (parentSession === undefined || origin !== 'subagent') continue
    const siblings = byParent.get(String(parentSession)) ?? []
    siblings.push(agent)
    byParent.set(String(parentSession), siblings)
  }
  const result: Agent[] = []
  const pending = [String(root.session.id)]
  const visited = new Set<string>()
  while (pending.length > 0) {
    const parentId = pending.shift() as string
    if (visited.has(parentId)) continue
    visited.add(parentId)
    for (const child of byParent.get(parentId) ?? []) {
      result.push(child)
      pending.push(String(child.id))
    }
  }
  return result
}

/** One live descendant by durable id, if still resident. */
export function liveChild(
  root: Agent,
  childId: string,
  registry: LiveAgentRegistryLike | undefined,
): Agent | undefined {
  return liveChildren(root, registry).find(child => String(child.id) === childId)
}

/**
 * Stop one child through the existing interrupt path. Used when a child will
 * not reach its park point or when a cancelled pause must not keep old work.
 */
export function stopChild(
  root: Agent,
  child: Agent,
  service: ChildStopServiceLike | undefined,
): void {
  try {
    if (service?.interrupt !== undefined) {
      service.interrupt(child.session.id, { kind: 'ancestor', agent: root })
    } else {
      child.cancel({ kind: 'parent' }, { keepInbox: true })
    }
  } catch {
    try {
      child.cancel({ kind: 'parent' }, { keepInbox: true })
    } catch {
      // A child already leaving cannot be stopped again.
    }
  }
}

/**
 * Flush, capture the durable checkpoint, and return its acknowledgment. The
 * checkpoint includes the current task, todo list, last assistant text, and
 * bounded artifact paths the session presented.
 */
export async function checkpointAgent(
  agent: Agent,
  pauseId: string,
  turn: number,
  step: number,
  forced: boolean,
  root: boolean,
  flush: (session: Session) => Promise<void>,
): Promise<ParkAcknowledgement> {
  await flush(agent.session)
  const atSeq = lastSeq(agent)
  const at = Date.now()
  const todos = latestTodos(agent)
  const text = latestAssistantText(agent)
  const artifacts = latestArtifactPaths(agent)
  const checkpointSeq = appendCheckpointEvent(agent, {
    pauseId,
    childId: root ? String(agent.session.id) : String(agent.id),
    turn,
    step,
    atSeq,
    at,
    forced,
    ...todos === undefined ? {} : { todos },
    ...text === '' ? {} : { lastAssistantText: text.slice(0, 2_000) },
    ...artifacts.length === 0 ? {} : { artifacts },
  })
  await flush(agent.session)
  return {
    pauseId,
    checkpointAt: at,
    checkpointSeq,
    ...artifacts.length === 0 ? {} : { artifacts },
  }
}

/** Wait until every park request acknowledges, or the bounded timeout ends. */
export async function waitForAcknowledgements(
  entries: ReadonlyMap<string, ParkEntry>,
  timeoutMs: number,
): Promise<void> {
  if (entries.size === 0) return
  await new Promise<void>(resolve => {
    let settled = false
    const timer = setTimeout(() => {
      if (settled) return
      settled = true
      resolve()
    }, timeoutMs)
    void Promise.all([...entries.values()].map(entry => entry.acknowledged)).then(() => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve()
    }, () => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve()
    })
  })
}
