/**
 * Ultra standing mode: selector/command/keyword activation, the full playbook
 * on arm/resume/compaction, and one compact reminder per human turn.
 *
 * The model authors workflow scripts; this module only supplies the standing
 * authorization and reminders. It never creates an autopilot run.
 */

import type { Agent } from '@deepseek-ai/dsh-agent'
import { createUserMessage, type UserMessage } from '@deepseek-ai/dsh-llm'
import type { ResolvedConfig } from './config.js'
import { hasUltracodeToken } from './detect.js'
import {
  ULTRA_REMINDER_PREFIX,
  ULTRA_STANDING_MARKER,
  ULTRA_STANDING_PLAYBOOK,
  ultraReminder,
} from './prompts.js'
import {
  appendModeEvent,
  hasFullPlaybookSinceCompaction,
  hasReminderForTurn,
  isRootAgent,
  latestModeEvent,
  latestModelSelection,
  sessionKey,
} from './state.js'

export interface UltraPreStep {
  readonly agent: Agent
  readonly messages: readonly UserMessage[]
  readonly turn: number
  readonly step: number
}

/** Owns the in-memory activation view; the durable state remains the log. */
export class UltraModeController {
  private readonly commandMode = new Set<string>()
  private readonly active = new Set<string>()

  constructor(private readonly config: ResolvedConfig) {}

  /** Load the command mode and current activation view for one agent. */
  onCreated(agent: Agent): void {
    if (!isRootAgent(agent)) return
    const key = sessionKey(agent)
    const mode = latestModeEvent(agent.session.snapshotEvents())
    if (mode?.source === 'command') {
      if (mode.enabled) this.commandMode.add(key)
      else this.commandMode.delete(key)
    }
    this.active.delete(key)
    if (this.isSelectorUltra(agent) || this.commandMode.has(key)) this.active.add(key)
  }

  /** Whether the model selection currently says `ultra`. */
  isSelectorUltra(agent: Agent): boolean {
    return latestModelSelection(agent.session.snapshotEvents())?.reasoningEffort === 'ultra'
  }

  /** Read the selected effort, for status output. */
  selectedEffort(agent: Agent): string | undefined {
    return latestModelSelection(agent.session.snapshotEvents())?.reasoningEffort
  }

  /** Enable or disable the effort-independent command mode. */
  setCommandMode(agent: Agent, enabled: boolean): void {
    const key = sessionKey(agent)
    if (enabled) this.commandMode.add(key)
    else this.commandMode.delete(key)
    appendModeEvent(agent, enabled, enabled ? 'command' : 'off', 'command')
  }

  /** Whether the command mode is on. */
  commandModeOn(agent: Agent): boolean {
    return this.commandMode.has(sessionKey(agent))
  }

  /** Drop in-memory state when the agent is disposed. */
  dispose(agent: Agent): void {
    const key = sessionKey(agent)
    this.commandMode.delete(key)
    this.active.delete(key)
  }

  /** Append the playbook and/or the per-turn reminder for this step. */
  onPreStep(payload: UltraPreStep): UserMessage[] {
    const { agent } = payload
    if (!isRootAgent(agent)) return []
    const key = sessionKey(agent)
    const selector = this.isSelectorUltra(agent)
    const command = this.commandMode.has(key)
    const keyword = payload.step === 1 && hasUltracodeToken(payload.messages)
    const armed = selector || command || keyword
    const wasActive = this.active.has(key)

    if (!armed) {
      if (wasActive) {
        this.active.delete(key)
        appendModeEvent(agent, false, 'standing mode off', 'selector')
      }
      return []
    }

    this.active.add(key)
    if (!wasActive) appendModeEvent(agent, true, 'standing mode on', selector ? 'selector' : command ? 'command' : 'keyword')

    const additions: UserMessage[] = []
    const hasPlaybook = hasFullPlaybookSinceCompaction(agent, ULTRA_STANDING_MARKER)
    if (!hasPlaybook) {
      additions.push(createUserMessage({
        content: [{ type: 'text', text: ULTRA_STANDING_PLAYBOOK }],
        source: { kind: 'ultracode' },
      }))
    } else if (
      this.config.ultraReminder
      && payload.step === 1
      && !hasReminderForTurn(agent, payload.turn, ULTRA_REMINDER_PREFIX)
    ) {
      additions.push(createUserMessage({
        content: [{ type: 'text', text: ultraReminder(payload.turn, this.config.fanoutLimit) }],
        source: { kind: 'ultracode', form: 'notice', summary: 'Ultra mode' },
      }))
    }
    return additions
  }
}
