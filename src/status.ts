/**
 * Generic, read-only status for the current root session.
 *
 * The report is folded from the live session log, the plugin's in-memory run
 * and pause state, and the composition's optional job registry. It never
 * opens a session archive, a profile directory, or another session's state.
 */

import type { Agent } from '@deepseek-ai/dsh-agent'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import { defineTool, type ToolDefinition } from '@deepseek-ai/dsh-tools'
import {
  isRootAgent,
  sessionKey,
  todoSnapshot,
  type RunState,
} from './state.js'

/** One live job owned by the calling session, in a shape any job reader satisfies. */
export interface StatusJobView {
  id: string
  kind: string
  label: string
  owner?: string
  status: string
  progress?: string
  detail?: string
  startedAt: number
}

/** One active autopilot run summary. */
export interface StatusRun {
  phase: string
  round: number
  maxRounds: number
}

/** Canonical, read-only status report returned by `session_status`. */
export interface SessionStatus {
  session: {
    id: string
    status: string
  }
  turn: number
  step: number
  run: StatusRun | null
  todos: {
    total: number
    completed: number
    open: number
    updatedAt: number | null
  }
  jobs: StatusJobView[]
  pause: {
    paused: boolean
    reason: string | null
  }
  generatedAt: number
}

/** Everything the pure fold needs; no session store or filesystem access. */
export interface StatusInput {
  sessionId: string
  sessionStatus: string
  events: readonly SessionEvent[]
  run?: RunState
  jobs?: readonly StatusJobView[]
  paused?: boolean
  pauseReason?: string
  now?: number
}

/** The pause surface the status tool reads. */
export interface StatusPause {
  isPaused(agent: Agent): boolean
  reasonOf(agent: Agent): string | undefined
}

/** Tool dependencies supplied by the plugin composition. */
export interface StatusToolDeps {
  runs: ReadonlyMap<string, RunState>
  pause: StatusPause
  readJobs(agent: Agent): readonly StatusJobView[]
}

const ACTIVE_JOB_STATUSES = new Set(['running', 'stopping'])

/** Fold a status report from live state without mutating anything. */
export function collectStatus(input: StatusInput): SessionStatus {
  const { turn, step } = currentTurnAndStep(input.events)
  const todos = todoSnapshot(input.events)
  const completed = todos?.todos.filter(todo => todo.status === 'completed').length ?? 0
  const total = todos?.todos.length ?? 0
  const activeJobs = (input.jobs ?? [])
    .filter(job => job.owner !== undefined
      && String(job.owner) === input.sessionId
      && ACTIVE_JOB_STATUSES.has(job.status))
    .map(job => ({
      id: job.id,
      kind: job.kind,
      label: job.label,
      status: job.status,
      startedAt: job.startedAt,
      ...job.progress === undefined ? {} : { progress: job.progress },
      ...job.detail === undefined ? {} : { detail: job.detail },
    }))

  return {
    session: { id: input.sessionId, status: input.sessionStatus },
    turn,
    step,
    run: input.run === undefined
      ? null
      : { phase: input.run.phase, round: input.run.round, maxRounds: input.run.maxRounds },
    todos: {
      total,
      completed,
      open: total - completed,
      updatedAt: todos?.updatedAt ?? null,
    },
    jobs: activeJobs,
    pause: {
      paused: input.paused === true,
      reason: input.paused === true ? input.pauseReason ?? 'unknown' : null,
    },
    generatedAt: input.now ?? Date.now(),
  }
}

/** Render a compact, model-readable report. */
export function renderStatus(status: SessionStatus): string {
  const lines = [
    `session status: ${status.session.id} (${status.session.status})`,
    `turn: ${status.turn}`,
    `step: ${status.step}`,
    status.run === null
      ? 'run: none'
      : `run: ${status.run.phase}, round ${status.run.round}/${status.run.maxRounds}`,
    status.todos.updatedAt === null
      ? `todos: ${status.todos.completed} completed, ${status.todos.open} open (never updated)`
      : `todos: ${status.todos.completed} completed, ${status.todos.open} open (updated ${new Date(status.todos.updatedAt).toISOString()})`,
    status.jobs.length === 0 ? 'jobs: none active' : `jobs: ${status.jobs.length} active`,
    ...status.jobs.map(job => `- ${job.id} (${job.kind}) "${job.label}": ${job.status}`
      + `${job.progress === undefined ? '' : `, progress ${job.progress}`}`
      + `${job.detail === undefined ? '' : `, ${job.detail}`}`),
    status.pause.paused
      ? `pause: paused (${status.pause.reason ?? 'unknown'})`
      : 'pause: not paused',
  ]
  return lines.join('\n')
}

/** Build the root-session `session_status` tool. */
export function createSessionStatusTool(deps: StatusToolDeps): ToolDefinition {
  return defineTool({
    name: 'session_status',
    description: 'Report the current root session status: turn, step, run phase/round, todo summary and last-updated time, active owned background jobs, and pause state. Read-only; it does not read session archives or files.',
    parameters: {},
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          session: {
            type: 'object',
            additionalProperties: false,
            properties: {
              id: { type: 'string', required: true },
              status: { type: 'string', required: true },
            },
          },
          turn: { type: 'integer', required: true },
          step: { type: 'integer', required: true },
          run: {
            oneOf: [
              {
                type: 'object',
                additionalProperties: false,
                properties: {
                  phase: { type: 'string', required: true },
                  round: { type: 'integer', required: true },
                  maxRounds: { type: 'integer', required: true },
                },
              },
              { type: 'null' },
            ],
          },
          todos: {
            type: 'object',
            additionalProperties: false,
            properties: {
              total: { type: 'integer', required: true },
              completed: { type: 'integer', required: true },
              open: { type: 'integer', required: true },
              updatedAt: {
                oneOf: [{ type: 'integer' }, { type: 'null' }],
              },
            },
          },
          jobs: {
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                id: { type: 'string', required: true },
                kind: { type: 'string', required: true },
                label: { type: 'string', required: true },
                status: { type: 'string', required: true },
                startedAt: { type: 'integer', required: true },
                progress: { type: 'string' },
                detail: { type: 'string' },
              },
            },
          },
          pause: {
            type: 'object',
            additionalProperties: false,
            properties: {
              paused: { type: 'boolean', required: true },
              reason: {
                oneOf: [{ type: 'string' }, { type: 'null' }],
              },
            },
          },
          generatedAt: { type: 'integer', required: true },
        },
      },
      render: (_args, value) => [{
        type: 'text',
        text: renderStatus(value as unknown as SessionStatus),
      }],
    },
    async execute(_args, exec) {
      const agent = exec.agent
      if (agent === undefined) throw new Error('session_status requires a calling agent')
      if (!isRootAgent(agent)) throw new Error('session_status is only available to the root agent')
      return collectStatus({
        sessionId: String(agent.session.id),
        sessionStatus: agent.status,
        events: agent.session.snapshotEvents(),
        run: deps.runs.get(sessionKey(agent)),
        jobs: deps.readJobs(agent),
        paused: deps.pause.isPaused(agent),
        pauseReason: deps.pause.reasonOf(agent),
      })
    },
  })
}

/** Fold the current turn and step from live log boundaries. */
export function currentTurnAndStep(events: readonly SessionEvent[]): { turn: number; step: number } {
  let turn = 0
  let step = 0
  for (const event of events) {
    if (event.type === 'turn/start') {
      turn = event.data.turn
      step = 0
      continue
    }
    const data: unknown = event.data
    if (typeof data !== 'object' || data === null) continue
    if (!('turn' in data) || !('step' in data)) continue
    const candidateTurn: unknown = data.turn
    const candidateStep: unknown = data.step
    if (typeof candidateTurn !== 'number' || typeof candidateStep !== 'number') continue
    turn = candidateTurn
    step = candidateStep
  }
  return { turn, step }
}
