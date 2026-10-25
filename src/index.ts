/**
 * DSH Ultracode host plugin: selector-level Ultra, standing playbook/reminders,
 * skill autopilot, steer-aware continuation, and pause/resume for root sessions.
 *
 * All model-visible additions are appended user messages. The plugin never
 * changes the system prompt, tool declarations, provider, model, or wire effort.
 */

import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { createUserMessage, type UserMessage } from '@deepseek-ai/dsh-llm'
import type { SkillDefinition } from '@deepseek-ai/dsh-skill'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type {} from '@deepseek-ai/dsh-working-directory'
import {
  handleAutopilotCommand,
  handlePauseCommand,
  handleResumeCommand,
  handleUltraCommand,
  type CommandContext,
} from './commands.js'
import { evaluateCompletion } from './completion.js'
import { resolveConfig, type PluginConfig } from './config.js'
import { findSkillInvocation, hasUserMessage } from './detect.js'
import { registerUltraEffort } from './effort.js'
import { ObservationController } from './observation.js'
import { PauseController } from './pause.js'
import { registerUltracodeProjection } from './projection.js'
import {
  autopilotBanner,
  changeApproachNudge,
  continuationNudge,
  wrapUpNudge,
} from './prompts.js'
import { installBusyEnterDefault } from './steering.js'
import { createSessionStatusTool, type StatusJobView } from './status.js'
import { TaskStateController } from './task-state.js'
import {
  appendRunEvent,
  createRunState,
  fromRunEvent,
  inboxHasUserWork,
  isRootAgent,
  isUnfinishedPhase,
  lastAssistantEndsWithQuestion,
  latestModelSelection,
  latestRunEvent,
  latestTodos,
  progressDigest,
  sessionKey,
  todoSummary,
  type RunState,
} from './state.js'
import { UltraModeController } from './ultra.js'

export const name = 'dsh-ultracode'
export const inject = ['tools', 'commands', 'workingDirectory']

/** Plugin entry: effort decoration, Ultra standing mode, autopilot, pause/resume. */
export function apply(ctx: Context, config: PluginConfig = {}): void {
  const settings = resolveConfig(config)
  const runs = new Map<string, RunState>()
  const hydrated = new Set<string>()
  const pause = new PauseController(settings, runs)
  const defaultSelection = (): { provider: string; model: string; reasoningEffort?: string } | undefined => {
    const service = (ctx as unknown as {
      get(name: string): unknown
    }).get('agentDefaultModel') as {
      currentSelection(): { provider: string; model: string; reasoningEffort?: string }
    } | undefined
    return service?.currentSelection()
  }
  const ultra = new UltraModeController(settings, defaultSelection)
  const taskState = new TaskStateController()
  const observation = new ObservationController()
  const selectMax = (agent: Agent): void => {
    const selection = latestModelSelection(agent.session.snapshotEvents())
    if (selection?.reasoningEffort !== 'ultra') return
    const fallback = (): void => {
      ;(agent.session as unknown as {
        append(type: string, data: unknown): unknown
      }).append('model/selection', {
        provider: selection.provider,
        model: selection.model,
        reasoningEffort: 'max',
      })
    }
    const controller = ctx.get('sessionController') as {
      selectModel(request: {
        sessionId: typeof agent.session.id
        provider: string
        model: string
        reasoningEffort: 'max'
      }): Promise<unknown>
    } | undefined
    if (controller === undefined) {
      fallback()
      return
    }
    void controller.selectModel({
      sessionId: agent.session.id,
      provider: selection.provider,
      model: selection.model,
      reasoningEffort: 'max',
    }).catch((error: unknown) => {
      console.error('[dsh-ultracode] unable to select Max through the session controller:', error)
      fallback()
    })
  }
  const commands: CommandContext = { runs, pause, ultra, selectMax }

  /**
   * Rebuild this instance's in-memory view from the durable log. A hot reload
   * creates a new plugin instance while agents stay live, so `agent/created`
   * will not fire for them again; `live` also tells pause restoration not to
   * treat the reload as a session restart. Existing sessions are read, never
   * rewritten.
   */
  const restoreAgent = (agent: Agent, live: boolean): void => {
    const key = sessionKey(agent)
    if (hydrated.has(key)) return
    hydrated.add(key)
    const event = latestRunEvent(agent.session.snapshotEvents())
    if (event !== undefined) runs.set(key, fromRunEvent(event, settings))
    else runs.delete(key)
    if (live) pause.hydrate(agent)
    else pause.onCreated(agent)
    ultra.onCreated(agent)
    if (pause.isPaused(agent) || runs.get(key)?.phase === 'paused_resume') {
      ultra.requestFullPlaybook(agent)
    }
  }

  const restoreLiveAgents = (scope: Context): void => {
    const agents = (scope as unknown as {
      get(name: string): unknown
    }).get('agents') as { list(): readonly Agent[] } | undefined
    for (const agent of agents?.list() ?? []) restoreAgent(agent, true)
  }

  // Disposal is a reload or an uninstall, never a reason to mutate a session.
  // A true shutdown ends the live turn with the process; the durable run
  // record is restored as `paused_resume` the next time the session loads.
  ctx.effect(() => () => {
    runs.clear()
    hydrated.clear()
  })

  if (settings.ultraEffort) registerUltraEffort(ctx)

  const stopSteering = installBusyEnterDefault(ctx, settings)
  ctx.effect(() => stopSteering)
  registerUltracodeProjection(ctx)

  ctx.on('agent/created', ({ agent, source }) => {
    const key = sessionKey(agent)
    if (source === 'clear') {
      hydrated.delete(key)
      runs.delete(key)
      pause.dispose(agent)
      ultra.dispose(agent)
      return undefined
    }
    restoreAgent(agent, false)
    return undefined
  })

  ctx.on('agent/disposed', ({ agent }: { agent: Agent }) => {
    const key = sessionKey(agent)
    hydrated.delete(key)
    runs.delete(key)
    pause.dispose(agent)
    ultra.dispose(agent)
  })

  // Restore live agents that outlived a previous plugin instance (hot reload).
  // Keep the inject form so a late-mounted registry is still scanned once.
  restoreLiveAgents(ctx)
  ctx.inject(['agents'], scoped => restoreLiveAgents(scoped))

  ctx.on('agent/error', ({ agent, turn }: { agent: Agent; turn: number }) => {
    pause.onError(agent, turn)
  })

  // The listener calls next() first, so the skill body and the catalog have
  // already been appended; our additions are always last.
  ctx.on('agent/pre-step', async (payload, next) => {
    const decision = await next()
    if (decision.kind === 'reject') return decision
    if (!isRootAgent(payload.agent)) return decision

    try {
      const { agent, messages, turn, step } = payload
      pause.onPreStep(agent, messages)

      const additions: UserMessage[] = []
      additions.push(...ultra.onPreStep({ agent, messages, turn, step }))
      additions.push(...taskState.onPreStep(agent))
      additions.push(...observation.onPreStep(agent))

      const key = sessionKey(agent)
      const current = runs.get(key)
      const terminal = current === undefined || !isUnfinishedPhase(current.phase)
      const invocation = findSkillInvocation(messages)

      if (invocation !== undefined && terminal) {
        const skill = await loadSkill(ctx, agent, invocation, payload.signal)
        const metadata = skill?.metadata
        if (metadata?.autopilot === true) {
          const metadataMaxRounds = typeof metadata.maxRounds === 'number' ? metadata.maxRounds : undefined
          const run = createRunState(invocation, settings, metadataMaxRounds)
          runs.set(key, run)
          additions.push(createUserMessage({
            content: [{ type: 'text', text: autopilotBanner(invocation, 1, run.maxRounds) }],
            source: { kind: 'autopilot' },
          }))
          run.phase = 'running'
          appendRunEvent(agent, run)
        }
      } else if (
        current !== undefined
        && (current.phase === 'waiting_user' || current.phase === 'paused_resume')
        && hasUserMessage(messages)
      ) {
        current.phase = 'running'
        appendRunEvent(agent, current)
      }

      if (additions.length === 0) return decision
      return { ...decision, messages: [...decision.messages, ...additions] }
    } catch (error: unknown) {
      console.error('[dsh-ultracode] pre-step failed:', error)
      return decision
    }
  })

  ctx.on('agent/turn-stopping', ({ agent, turn, signal }: { agent: Agent; turn: number; signal: AbortSignal }) => {
    if (!isRootAgent(agent)) return
    const run = runs.get(sessionKey(agent))

    if (run !== undefined && run.phase === 'running') {
      const pauseResult = pause.onTurnStopping(agent, turn, signal)
      if (pauseResult === 'cancelled') {
        run.phase = 'cancelled'
        run.reason = 'turn cancelled'
        appendRunEvent(agent, run)
        return
      }
      if (pauseResult === 'paused') return

      if (inboxHasUserWork(agent)) return

      if (lastAssistantEndsWithQuestion(agent)) {
        run.phase = 'waiting_user'
        appendRunEvent(agent, run)
        return
      }

      if (run.round >= run.maxRounds) {
        wrapUp(agent, run, 'round limit')
        return
      }
      if (Date.now() - run.startedAt >= run.maxDurationMs) {
        wrapUp(agent, run, 'time limit')
        return
      }

      const digest = progressDigest(agent)
      if (digest === run.noProgressDigest) {
        run.noProgressCount += 1
      } else {
        run.noProgressDigest = digest
        run.noProgressCount = 1
      }

      if (run.noProgressCount > settings.noProgressRounds) {
        wrapUp(agent, run, 'no progress')
        return
      }
      if (run.noProgressCount === settings.noProgressRounds) {
        agent.steer(createUserMessage({
          content: [{ type: 'text', text: changeApproachNudge(run.skill) }],
          source: { kind: 'autopilot' },
        }))
        return
      }

      run.round += 1
      appendRunEvent(agent, run)
      agent.steer(createUserMessage({
        content: [{
          type: 'text',
          text: continuationNudge(run.skill, run.round, run.maxRounds, todoSummary(agent), run.reason ?? 'unknown'),
        }],
        source: { kind: 'autopilot' },
      }))
      return
    }

    // No running skill run: still persist a paused root session on Stop/crash.
    pause.onTurnStopping(agent, turn, signal)
  })

  const completeRun = defineTool({
    name: 'complete_run',
    description: 'Finish the active autopilot run. Call only when every part of the skill\'s work is done and verified, or when you are blocked.',
    parameters: {
      summary: { type: 'string', required: true, description: 'What was completed, with evidence.' },
      artifacts: { type: 'array', items: { type: 'string' }, description: 'Paths or URLs produced.' },
      remaining: { type: 'array', items: { type: 'string' }, description: 'Remaining work. Must be empty unless blocked.' },
      blocked: { type: 'string', description: 'A concrete blocker. Set only when you cannot finish.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          summary: { type: 'string', required: true },
          blocked: { type: 'boolean', required: true },
        },
      },
      render: (_args, value) => [{
        type: 'text',
        text: value.blocked ? `Run blocked: ${value.summary}` : `Run complete: ${value.summary}`,
      }],
    },
    async execute(args, exec) {
      const agent = exec.agent
      if (agent === undefined) throw new Error('complete_run requires a calling agent')
      if (!isRootAgent(agent)) throw new Error('complete_run is only available to the root agent')

      const key = sessionKey(agent)
      const run = runs.get(key)
      if (run === undefined || run.phase !== 'running') {
        throw new Error('No active autopilot run.')
      }

      const summary = args.artifacts !== undefined && args.artifacts.length > 0
        ? `${args.summary} [artifacts: ${args.artifacts.join(', ')}]`
        : args.summary

      const openTodos = (latestTodos(agent) ?? []).filter(todo => todo.status !== 'completed')
      const decision = evaluateCompletion(args, openTodos)
      if (decision.kind === 'more') throw new Error(decision.error)

      if (decision.kind === 'blocked') {
        run.phase = 'exhausted'
        run.reason = decision.reason
        appendRunEvent(agent, run)
        pause.complete(agent)
        exec.concludeTurn()
        return { summary, blocked: true }
      }

      run.phase = 'completed'
      appendRunEvent(agent, run)
      pause.complete(agent)
      exec.concludeTurn()
      return { summary, blocked: false }
    },
  })
  ctx.tools.register(completeRun)
  ctx.tools.register(createSessionStatusTool({
    runs,
    pause,
    readJobs: (agent) => {
      const jobs = ctx.get('jobs') as {
        list(caller: typeof agent.session.id): readonly StatusJobView[]
      } | undefined
      return jobs?.list(agent.session.id) ?? []
    },
  }))

  ctx.commands.register({
    name: 'autopilot',
    description: 'Inspect or control the active autopilot run',
    input: { hint: '[status|off|pause|resume]' },
    handler: invocation => handleAutopilotCommand(invocation.agent, invocation.rawInput, commands),
  })

  ctx.commands.register({
    name: 'pause',
    description: 'Pause the current root session and keep it resumable',
    recordInput: false,
    handler: invocation => handlePauseCommand(invocation.agent, commands),
  })

  ctx.commands.register({
    name: 'resume',
    description: 'Resume a paused root session or autopilot run',
    recordInput: false,
    handler: invocation => handleResumeCommand(invocation.agent, commands),
  })

  ctx.commands.register({
    name: 'ultra',
    description: 'Toggle the Ultra standing mode or run an explicit Ultra task',
    input: { hint: '[on|off|status|<task>]' },
    recordInput: false,
    handler: invocation => handleUltraCommand(invocation.agent, invocation.rawInput, commands),
  })
}

function wrapUp(agent: Agent, run: RunState, reason: string): void {
  run.phase = 'exhausted'
  run.reason = reason
  appendRunEvent(agent, run)
  agent.steer(createUserMessage({
    content: [{ type: 'text', text: wrapUpNudge(run.skill, reason) }],
    source: { kind: 'autopilot' },
  }))
}

async function loadSkill(
  ctx: Context,
  agent: Agent,
  name: string,
  signal: AbortSignal,
): Promise<SkillDefinition | undefined> {
  const skills = ctx.get('skills') as {
    get(skillName: string, options: { cwd: string; scope: Agent }): Promise<SkillDefinition | undefined>
  } | undefined
  if (skills === undefined) return undefined
  const cwd = await ctx.workingDirectory.ensure(agent, signal)
  return await skills.get(name, { cwd, scope: agent })
}
