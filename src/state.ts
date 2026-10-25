/** Per-run state, durable event folding, and session-log reads used by the plugin. */

import { randomUUID } from 'node:crypto'
import type { ContentBlock, UserMessage } from '@deepseek-ai/dsh-llm'
import type { Session, SessionEvent } from '@deepseek-ai/dsh-session'
import { maxDurationFor, maxRoundsFor, type ResolvedConfig } from './config.js'
import type {
  AutopilotPhase,
  AutopilotRunEvent,
  ProjectionRun,
  UltracodeModeEvent,
  UltracodePauseEvent,
} from './types.js'

/** The subset of a live agent used by the state helpers; a real Agent is assignable. */
export interface SessionCarrier {
  readonly session: Session
}

/** The inbox surface the steering guard reads. */
export interface InboxCarrier {
  readonly inbox: {
    readonly nextTurn: readonly UserMessage[]
    readonly nextStep: readonly UserMessage[]
  }
}

/** Live state for one autopilot run. */
export interface RunState {
  runId: string
  skill: string
  phase: AutopilotPhase
  round: number
  maxRounds: number
  maxDurationMs: number
  startedAt: number
  updatedAt: number
  reason?: string
  noProgressDigest?: string
  noProgressCount: number
  playbookInjected: boolean
}

/** One todo item as written by the todo tool. */
export interface TodoItem {
  content: string
  status: string
}

/** A session's selected provider/model/effort, read from the durable log. */
export interface ModelSelection {
  provider: string
  model: string
  reasoningEffort?: string
}

/** The latest durable turn closer. */
export interface TurnEndInfo {
  turn: number
  reason: string
  seq: number
}

/** Return whether the agent is a root agent rather than a delegated child. */
export function isRootAgent(agent: SessionCarrier): boolean {
  return agent.session.header.parentSession === undefined && agent.session.header.origin !== 'subagent'
}

/** Stable map key for one session. */
export function sessionKey(agent: SessionCarrier): string {
  return String(agent.session.id)
}

/** Create a fresh run in the armed state. */
export function createRunState(
  skill: string,
  config: ResolvedConfig,
  metadataMaxRounds?: number,
): RunState {
  const now = Date.now()
  return {
    runId: randomUUID(),
    skill,
    phase: 'armed',
    round: 1,
    maxRounds: maxRoundsFor(skill, metadataMaxRounds, config),
    maxDurationMs: maxDurationFor(skill, config),
    startedAt: now,
    updatedAt: now,
    noProgressCount: 0,
    playbookInjected: false,
  }
}

/** Restore live state from a durable event. */
export function fromRunEvent(event: AutopilotRunEvent, config: ResolvedConfig): RunState {
  return {
    runId: event.runId,
    skill: event.skill,
    phase: event.phase,
    round: event.round,
    maxRounds: event.maxRounds,
    maxDurationMs: maxDurationFor(event.skill, config),
    startedAt: event.startedAt,
    updatedAt: event.updatedAt,
    ...event.reason === undefined ? {} : { reason: event.reason },
    noProgressCount: 0,
    playbookInjected: true,
  }
}

/** Append the current run state as a log-only event. */
export function appendRunEvent(agent: SessionCarrier, run: RunState): void {
  run.updatedAt = Date.now()
  agent.session.append('autopilot/run', {
    runId: run.runId,
    skill: run.skill,
    phase: run.phase,
    round: run.round,
    maxRounds: run.maxRounds,
    startedAt: run.startedAt,
    updatedAt: run.updatedAt,
    ...run.reason === undefined ? {} : { reason: run.reason },
  })
}

/** Append the Ultra mode toggle as a log-only event. */
export function appendModeEvent(
  agent: SessionCarrier,
  enabled: boolean,
  reason?: string,
  source?: UltracodeModeEvent['source'],
): void {
  agent.session.append('ultracode/mode', {
    enabled,
    ...reason === undefined ? {} : { reason },
    ...source === undefined ? {} : { source },
    updatedAt: Date.now(),
  })
}

/** Append the pause state as a log-only event. */
export function appendPauseEvent(agent: SessionCarrier, event: UltracodePauseEvent): void {
  agent.session.append('ultracode/pause', event)
}

/** Read the newest run event from a session snapshot. */
export function latestRunEvent(events: readonly SessionEvent[]): AutopilotRunEvent | undefined {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index]
    if (event !== undefined && event.type === 'autopilot/run') return event.data
  }
  return undefined
}

/** Read the newest mode event from a session snapshot. */
export function latestModeEvent(events: readonly SessionEvent[]): UltracodeModeEvent | undefined {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index]
    if (event !== undefined && event.type === 'ultracode/mode') return event.data
  }
  return undefined
}

/** Read the newest pause event from a session snapshot. */
export function latestPauseEvent(events: readonly SessionEvent[]): UltracodePauseEvent | undefined {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index]
    if (event !== undefined && event.type === 'ultracode/pause') return event.data
  }
  return undefined
}

/** Read the newest model selection event. */
export function latestModelSelection(events: readonly SessionEvent[]): ModelSelection | undefined {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index]
    if (event === undefined || (event.type as string) !== 'model/selection') continue
    const data = event.data as {
      provider?: unknown
      model?: unknown
      reasoningEffort?: unknown
    }
    if (typeof data.provider !== 'string' || typeof data.model !== 'string') continue
    return {
      provider: data.provider,
      model: data.model,
      ...typeof data.reasoningEffort === 'string' ? { reasoningEffort: data.reasoningEffort } : {},
    }
  }
  return undefined
}

/** Read the newest durable turn closer. */
export function latestTurnEnd(events: readonly SessionEvent[]): TurnEndInfo | undefined {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index]
    if (event === undefined || event.type !== 'turn/end') continue
    const reason = (event.data.reason as { kind?: unknown }).kind
    return {
      turn: event.data.turn,
      reason: typeof reason === 'string' ? reason : 'unknown',
      seq: event.seq,
    }
  }
  return undefined
}

/** The currently open turn number, or 0 when the log is balanced. */
export function openTurn(agent: SessionCarrier): number {
  let open = 0
  for (const event of agent.session.snapshotEvents()) {
    if (event.type === 'turn/start') open = event.data.turn
    else if (event.type === 'turn/end') open = 0
  }
  return open
}

/** Whether a human-authored prompt appears after the given seq. */
export function hasHumanMessageAfter(events: readonly SessionEvent[], seq: number): boolean {
  return events.some(event => event.seq > seq
    && event.type === 'user/message'
    && event.data.source.kind === 'user')
}

/** Whether a run is in a phase that still owns unfinished work. */
export function isUnfinishedPhase(phase: AutopilotPhase): boolean {
  return phase === 'armed'
    || phase === 'running'
    || phase === 'waiting_user'
    || phase === 'paused_user'
    || phase === 'paused_resume'
}

/** Whether the inbox holds any pending user work (queue or steering). */
export function inboxHasUserWork(agent: InboxCarrier): boolean {
  return agent.inbox.nextTurn.length > 0 || agent.inbox.nextStep.length > 0
}

/** Read the newest whole todo list, or undefined when the todo tool never wrote one. */
export function latestTodos(agent: SessionCarrier): TodoItem[] | undefined {
  const events = agent.session.snapshotEvents()
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index]
    if (event === undefined) continue
    const todos = todoItemsOf(event)
    if (todos !== undefined) return todos
  }
  return undefined
}

/** Compact todo summary for a continuation nudge. */
export function todoSummary(agent: SessionCarrier): string {
  const todos = latestTodos(agent)
  if (todos === undefined) return 'none'
  const completed = todos.filter(todo => todo.status === 'completed').length
  const open = todos.length - completed
  return `${completed} completed, ${open} open`
}

/** The newest assistant message's text, or an empty string. */
export function latestAssistantText(agent: SessionCarrier): string {
  const events = agent.session.snapshotEvents()
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index]
    if (event === undefined || event.type !== 'assistant/message') continue
    const parts: string[] = []
    for (const block of event.data.message.content) {
      if (block.type === 'text') parts.push(block.text)
    }
    return parts.join('\n')
  }
  return ''
}

/** Whether the newest assistant message ends with a question mark. */
export function lastAssistantEndsWithQuestion(agent: SessionCarrier): boolean {
  const text = latestAssistantText(agent).trim()
  return text.endsWith('?') || text.endsWith('？')
}

/** A stable digest of recent observable progress. */
export function progressDigest(agent: SessionCarrier): string {
  const events = agent.session.snapshotEvents()
  const calls: string[] = []
  const resultLengths: number[] = []
  for (const event of events) {
    if (event.type === 'tool/call') {
      calls.push(event.data.name)
      if (calls.length > 5) calls.shift()
    } else if (event.type === 'tool/result') {
      resultLengths.push(blockTextLength(event.data.message.content))
      if (resultLengths.length > 5) resultLengths.shift()
    }
  }
  return JSON.stringify({
    calls,
    resultLengths,
    todo: latestTodos(agent) ?? [],
    assistant: latestAssistantText(agent).length,
  })
}

/** The newest session event sequence, or 0 for an empty log. */
export function lastSeq(agent: SessionCarrier): number {
  const events = agent.session.snapshotEvents()
  const last = events[events.length - 1]
  return last === undefined ? 0 : last.seq
}

/** Whether the full Ultra playbook appears after the latest compaction. */
export function hasFullPlaybookSinceCompaction(agent: SessionCarrier, marker: string): boolean {
  const events = agent.session.snapshotEvents()
  let lastCompaction = -1
  let lastPlaybook = -1
  for (let index = 0; index < events.length; index += 1) {
    const event = events[index]
    if (event === undefined) continue
    if ((event.type as string) === 'compaction/end') lastCompaction = index
    if (event.type === 'user/message'
      && event.data.source.kind === 'ultracode'
      && messageText(event.data).includes(marker)) {
      lastPlaybook = index
    }
  }
  return lastPlaybook > lastCompaction
}

/** Whether the compact reminder for one turn already appears in the log. */
export function hasReminderForTurn(agent: SessionCarrier, turn: number, markerPrefix: string): boolean {
  const marker = `${markerPrefix}${turn}]`
  return agent.session.snapshotEvents().some(event => event.type === 'user/message'
    && event.data.source.kind === 'ultracode'
    && messageText(event.data).includes(marker))
}

/** Project one live run into the client projection shape. */
export function toProjectionRun(run: RunState): ProjectionRun {
  return {
    runId: run.runId,
    skill: run.skill,
    phase: run.phase,
    round: run.round,
    maxRounds: run.maxRounds,
  }
}

/** Concatenate text blocks of one user message. */
export function messageText(message: UserMessage): string {
  return message.content.map(block => block.type === 'text' ? block.text : '').join('\n')
}

function todoItemsOf(event: SessionEvent): TodoItem[] | undefined {
  if ((event.type as string) !== 'todo/write') return undefined
  const data: unknown = event.data
  if (typeof data !== 'object' || data === null || !('todos' in data)) return undefined
  const todos: unknown = data.todos
  if (!Array.isArray(todos)) return undefined
  const result: TodoItem[] = []
  for (const todo of todos) {
    if (typeof todo !== 'object' || todo === null) return undefined
    if (!('content' in todo) || typeof todo.content !== 'string') return undefined
    if (!('status' in todo) || typeof todo.status !== 'string') return undefined
    result.push({ content: todo.content, status: todo.status })
  }
  return result
}

function blockTextLength(blocks: readonly ContentBlock[]): number {
  let length = 0
  for (const block of blocks) {
    if (block.type === 'text') length += block.text.length
  }
  return length
}
