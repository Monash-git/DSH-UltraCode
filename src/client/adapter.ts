/**
 * Client-slot adapter for the primary Send/Pause/Play action.
 *
 * DSH declares `conversation.input.primary` and owns the default Send/Stop
 * button; this plugin registers one occupant that takes over only for a
 * running, waiting, or paused root session with an empty draft. The occupant
 * calls the existing Host `/pause` and `/resume` commands, so the protocol
 * stays in the Host half and no second pause button is needed.
 */

import en from '../../locale/en.json' with { type: 'json' }
import zh from '../../locale/zh.json' with { type: 'json' }

export const NS = 'ultracode'

/** One reply from the Host command transport. */
export interface PrimaryCommandReply {
  readonly ok: boolean
  readonly value?: { readonly result: { readonly kind: string; readonly text?: string } }
  readonly error?: { readonly message?: string }
}

/** The `remote.commands` slice used by the primary action. */
export interface PrimaryCommandTransport {
  execute(
    sessionId: string,
    line: string,
    attachments?: readonly unknown[],
  ): Promise<PrimaryCommandReply>
}

/** The client services the primary-slot adapter needs. */
export interface PrimarySlotContext {
  readonly slots: {
    inject(name: string, register: () => unknown): unknown
    register(spec: Record<string, unknown>, component: unknown): unknown
  }
  readonly remote: { readonly commands: PrimaryCommandTransport }
  readonly locale: {
    register(namespace: string, dictionaries: Record<string, Record<string, string>>): unknown
  }
  effect(callback: () => unknown): unknown
}

/** Run one Host command, turning transport and command errors into throws. */
export async function executeHostCommand(
  commands: PrimaryCommandTransport,
  sessionId: string,
  line: string,
): Promise<void> {
  const result = await commands.execute(sessionId, line, [])
  if (!result.ok) throw new Error(result.error?.message ?? 'command failed')
  if (result.value?.result.kind === 'error') {
    throw new Error(result.value.result.text ?? 'command failed')
  }
}

/** Register the primary-slot occupant and its locale dictionaries. */
export function applyClient(ctx: PrimarySlotContext, component: unknown): void {
  ctx.effect(() => ctx.locale.register(NS, { zh, en }))
  ctx.slots.inject('conversation.input.primary', () => ctx.slots.register({
    name: 'conversation.input.primary',
    locale: NS,
    inject: (sessionId: string) => ({
      executeCommand: (line: string): Promise<void> =>
        executeHostCommand(ctx.remote.commands, sessionId, line),
    }),
  }, component))
}
