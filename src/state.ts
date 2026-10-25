/** Per-run state, durable event folding, and session-log reads used by the plugin. */

import { randomUUID } from 'node:crypto'
import type { ContentBlock, UserMessage } from '@deepseek-ai/dsh-llm'
import { appendPluginRecord, pluginRecordOf, type Session, type SessionEvent } from '@deepseek-ai/dsh-session'
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

/** The subset of one background job the turn-yield check reads. */
export interface JobViewLike {
  readonly id?: unknown
  readonly owner?: unknown
  readonly status: string
}

/** The subset of the optional `ctx.jobs` service the plugin depends on. */
export interface JobRegistryLike {
  list(caller?: unknown): readonly JobViewLike[]
}

/**
 * The first `running` job owned by this session. `stopping` jobs settle as
 * killed and deliberately send no completion notice, and unowned jobs wake
 * nobody, so yielding on either would strand the run.
 */
export function liveOwnedJob(
  registry: JobRegistryLike | undefined,
  owner: unknown,
): JobViewLike | undefined {
  if (registry === undefined) return undefined
  return registry.list(owner).find(job => job.owner === owner && job.status === 'running')
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
  /** Non-active milliseconds accumulated after earlier waiting spans. */
  inactiveMs: number
  /** When the current waiting span began; absent while the run is active. */
  inactiveSince?: number
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
    inactiveMs: 0,
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
    inactiveMs: 0,
  }
}

/**
 * Stop the active-duration clock. Waiting for a background job, waiting for
 * the user, and a paused run do not spend the run's duration budget.
 */
export function markRunWaiting(run: RunState, now = Date.now()): void {
  if (run.inactiveSince === undefined) run.inactiveSince = now
}

/** Resume the active-duration clock and accumulate the span just ended. */
export function resumeRunActive(run: RunState, now = Date.now()): void {
  if (run.inactiveSince === undefined) return
  run.inactiveMs += Math.max(0, now - run.inactiveSince)
  run.inactiveSince = undefined
}

/** Elapsed active time: wall clock minus every waiting or paused span. */
export function activeElapsedMs(run: RunState, now = Date.now()): number {
  const currentWait = run.inactiveSince === undefined ? 0 : Math.max(0, now - run.inactiveSince)
  return Math.max(0, now - run.startedAt - run.inactiveMs - currentWait)
}

/** Plugin-record types: unknown readers skip them because the envelope is ignorable. */
export const RUN_RECORD = 'plugin:ultracode/run' as const
export const MODE_RECORD = 'plugin:ultracode/mode' as const
export const PAUSE_RECORD = 'plugin:ultracode/pause' as const

/** Append the current run state as an ignorable plugin record. */
export function appendRunEvent(agent: SessionCarrier, run: RunState): void {
  run.updatedAt = Date.now()
  appendPluginRecord(agent.session, RUN_RECORD, {
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

/** Append the Ultra mode toggle as an ignorable plugin record. */
export function appendModeEvent(
  agent: SessionCarrier,
  enabled: boolean,
  reason?: string,
  source?: UltracodeModeEvent['source'],
): void {
  appendPluginRecord(agent.session, MODE_RECORD, {
    enabled,
    ...reason === undefined ? {} : { reason },
    ...source === undefined ? {} : { source },
    updatedAt: Date.now(),
  })
}

/** Append the pause state as an ignorable plugin record. */
export function appendPauseEvent(agent: SessionCarrier, event: UltracodePauseEvent): void {
  appendPluginRecord(agent.session, PAUSE_RECORD, event)
}

/** Read the newest run record from a session snapshot. */
export function latestRunEvent(events: readonly SessionEvent[]): AutopilotRunEvent | undefined {
  const event = lastEvent(events, candidate => recordData<AutopilotRunEvent>(candidate, RUN_RECORD, 'autopilot/run') !== undefined)
  return event === undefined ? undefined : recordData<AutopilotRunEvent>(event, RUN_RECORD, 'autopilot/run')
}

/** Read the newest mode record from a session snapshot. */
export function latestModeEvent(events: readonly SessionEvent[]): UltracodeModeEvent | undefined {
  const event = lastEvent(events, candidate => recordData<UltracodeModeEvent>(candidate, MODE_RECORD, 'ultracode/mode') !== undefined)
  return event === undefined ? undefined : recordData<UltracodeModeEvent>(event, MODE_RECORD, 'ultracode/mode')
}

/** Read the newest pause record and its sequence from a session snapshot. */
export function latestPauseInfo(
  events: readonly SessionEvent[],
): { readonly data: UltracodePauseEvent; readonly seq: number } | undefined {
  const event = lastEvent(events, candidate => recordData<UltracodePauseEvent>(candidate, PAUSE_RECORD, 'ultracode/pause') !== undefined)
  if (event === undefined) return undefined
  const data = recordData<UltracodePauseEvent>(event, PAUSE_RECORD, 'ultracode/pause')
  return data === undefined ? undefined : { data, seq: event.seq }
}

/** Read the newest pause record from a session snapshot. */
export function latestPauseEvent(events: readonly SessionEvent[]): UltracodePauseEvent | undefined {
  return latestPauseInfo(events)?.data
}

function recordData<T>(event: SessionEvent, recordType: string, legacyType?: string): T | undefined {
  const record = pluginRecordOf(event)
  if (record?.type === recordType) return record.data as T
  if (legacyType !== undefined && (event.type as string) === legacyType) return event.data as T
  return undefined
}

/** Read the newest model selection event. */
export function latestModelSelection(events: readonly SessionEvent[]): ModelSelection | undefined {
  const event = lastEvent(events, candidate => (candidate.type as string) === 'model/selection')
  if (event === undefined) return undefined
  const data = event.data as {
    provider?: unknown
    model?: unknown
    reasoningEffort?: unknown
  }
  if (typeof data.provider !== 'string' || typeof data.model !== 'string') return undefined
  return {
    provider: data.provider,
    model: data.model,
    ...typeof data.reasoningEffort === 'string' ? { reasoningEffort: data.reasoningEffort } : {},
  }
}

/** Read the newest durable turn closer. */
export function latestTurnEnd(events: readonly SessionEvent[]): TurnEndInfo | undefined {
  const event = lastEvent(events, candidate => candidate.type === 'turn/end')
  if (event?.type !== 'turn/end') return undefined
  const reason = (event.data.reason as { kind?: unknown }).kind
  return {
    turn: event.data.turn,
    reason: typeof reason === 'string' ? reason : 'unknown',
    seq: event.seq,
  }
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

/** Whether the session has opened or closed a turn, so it is no longer blank. */
export function hasPriorTurn(agent: SessionCarrier): boolean {
  return agent.session.snapshotEvents().some(
    event => event.type === 'turn/start' || event.type === 'turn/end',
  )
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
    || phase === 'waiting_job'
    || phase === 'paused_user'
    || phase === 'paused_resume'
}

/** Whether the inbox holds pending human work (queue or steering). */
export function inboxHasUserWork(agent: InboxCarrier): boolean {
  const isHuman = (message: UserMessage): boolean => message.source.kind === 'user'
  return agent.inbox.nextTurn.some(isHuman) || agent.inbox.nextStep.some(isHuman)
}

/** Read the newest whole todo list, or undefined when the todo tool never wrote one. */
export function latestTodos(agent: SessionCarrier): TodoItem[] | undefined {
  const event = lastEvent(agent.session.snapshotEvents(), candidate => todoItemsOf(candidate) !== undefined)
  return event === undefined ? undefined : todoItemsOf(event)
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
  const event = lastEvent(agent.session.snapshotEvents(), candidate => candidate.type === 'assistant/message')
  if (event?.type !== 'assistant/message') return ''
  const parts: string[] = []
  for (const block of event.data.message.content) {
    if (block.type === 'text') parts.push(block.text)
  }
  return parts.join('\n')
}

function lastEvent(
  events: readonly SessionEvent[],
  predicate: (event: SessionEvent) => boolean,
): SessionEvent | undefined {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index]
    if (event !== undefined && predicate(event)) return event
  }
  return undefined
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

/** Whether a plugin prompt carrying the marker appears after the latest compaction. */
export function hasPromptSinceCompaction(agent: SessionCarrier, marker: string): boolean {
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
