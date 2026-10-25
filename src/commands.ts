/** Host command handlers for autopilot, pause/resume, and Ultra compatibility. */

import type { Agent } from '@deepseek-ai/dsh-agent'
import type { CommandResult } from '@deepseek-ai/dsh-commands'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import type { PauseController } from './pause.js'
import { appendRunEvent, sessionKey, type RunState } from './state.js'
import type { UltraModeController } from './ultra.js'

export interface CommandContext {
  readonly runs: Map<string, RunState>
  readonly pause: PauseController
  readonly ultra: UltraModeController
  /** Switch the live session selection from Ultra to Max through the session controller. */
  selectMax(agent: Agent): void
}

/** Handle `/autopilot [status|off|pause|resume]`. */
export function handleAutopilotCommand(
  agent: Agent,
  rawInput: string,
  context: CommandContext,
): CommandResult {
  const input = rawInput.trim().toLowerCase()
  const key = sessionKey(agent)
  const run = context.runs.get(key)

  if (input === '' || input === 'status') {
    const runStatus = run === undefined
      ? 'No active autopilot run.'
      : `Autopilot ${run.skill}: ${run.phase}${run.phase === 'waiting_job' ? ' (waiting for a background job)' : ''}, round ${run.round}/${run.maxRounds}.`
    const parts = [
      runStatus,
      `Ultra mode: ${context.ultra.isSelectorUltra(agent) || context.ultra.commandModeOn(agent) ? 'on' : 'off'}.`,
      ...context.pause.isPaused(agent) ? [`Paused: ${context.pause.reasonOf(agent) ?? 'unknown'}.`] : [],
    ]
    return { kind: 'success', text: parts.join(' ') }
  }

  if (input === 'off') {
    context.pause.requestCancel(agent)
    if (run !== undefined) {
      run.phase = 'cancelled'
      run.reason = 'user command'
      appendRunEvent(agent, run)
      context.runs.delete(key)
    }
    return { kind: 'success', text: 'Autopilot off.' }
  }

  if (input === 'pause') {
    const outcome = context.pause.pause(agent)
    return outcome.ok ? { kind: 'success', text: outcome.text } : { kind: 'error', text: outcome.text }
  }

  if (input === 'resume') {
    const outcome = context.pause.resume(agent)
    if (outcome.ok) context.ultra.requestFullPlaybook(agent)
    return outcome.ok ? { kind: 'success', text: outcome.text } : { kind: 'error', text: outcome.text }
  }

  return { kind: 'error', text: 'Usage: /autopilot [status|off|pause|resume]' }
}

/** Handle `/pause`. */
export function handlePauseCommand(agent: Agent, context: CommandContext): CommandResult {
  const outcome = context.pause.pause(agent)
  return outcome.ok ? { kind: 'success', text: outcome.text } : { kind: 'error', text: outcome.text }
}

/** Handle `/resume`; waits for child release so warnings reach the command card. */
export async function handleResumeCommand(agent: Agent, context: CommandContext): Promise<CommandResult> {
  const outcome = await context.pause.resumeAsync(agent)
  if (outcome.ok) context.ultra.requestFullPlaybook(agent)
  return outcome.ok ? { kind: 'success', text: outcome.text } : { kind: 'error', text: outcome.text }
}

/** Handle `/ultra [on|off|status|<task>]`. */
export function handleUltraCommand(
  agent: Agent,
  rawInput: string,
  context: CommandContext,
): CommandResult {
  const input = rawInput.trim()
  const lower = input.toLowerCase()

  if (input === '' || lower === 'status') {
    const selection = context.ultra.selectedEffort(agent)
    return {
      kind: 'success',
      text: [
        `Ultra selector: ${selection === 'ultra' ? 'on' : 'off'}${selection === undefined ? '' : ` (effort ${selection})`}.`,
        `Ultra command mode: ${context.ultra.commandModeOn(agent) ? 'on' : 'off'}.`,
        ...context.pause.isPaused(agent) ? [`Paused: ${context.pause.reasonOf(agent) ?? 'unknown'}.`] : [],
      ].join(' '),
    }
  }

  if (lower === 'on') {
    context.ultra.setCommandMode(agent, true)
    return { kind: 'success', text: 'Ultra standing mode on.' }
  }

  if (lower === 'off') {
    context.ultra.setCommandMode(agent, false)
    context.selectMax(agent)
    return { kind: 'success', text: 'Ultra mode off.' }
  }

  context.ultra.setCommandMode(agent, true)
  agent.followup(createUserMessage({
    content: [{ type: 'text', text: input }],
    source: { kind: 'ultracode' },
  }))
  return { kind: 'success', text: 'Ultra mode on. Task queued.' }
}
