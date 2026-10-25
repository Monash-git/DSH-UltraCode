/** Pure detection helpers for user-invoked skills and the Ultracode keyword. */

import type { UserMessage } from '@deepseek-ai/dsh-llm'

/** Return the kebab-case skill name from a leading `/name` user message, if any. */
export function findSkillInvocation(messages: readonly UserMessage[]): string | undefined {
  for (const message of messages) {
    if (message.source.kind !== 'user') continue
    const first = textOf(message).split('\n', 1)[0]?.trim() ?? ''
    const match = /^\/([a-z0-9]+(?:-[a-z0-9]+)*)(?:\s|$)/.exec(first)
    if (match?.[1] !== undefined) return match[1]
  }
  return undefined
}

/** Whether a user message contains a standalone `ultracode` token outside code. */
export function hasUltracodeToken(messages: readonly UserMessage[]): boolean {
  return messages.some(message => message.source.kind === 'user' && /\bultracode\b/i.test(stripCode(textOf(message))))
}

/** Whether any message came from the human user. */
export function hasUserMessage(messages: readonly UserMessage[]): boolean {
  return messages.some(message => message.source.kind === 'user')
}

/** Join one message's text blocks. */
export function textOf(message: UserMessage): string {
  const parts: string[] = []
  for (const block of message.content) {
    if (block.type === 'text') parts.push(block.text)
  }
  return parts.join('\n')
}

/** Remove fenced and inline code so keyword detection ignores examples. */
export function stripCode(text: string): string {
  return text.replace(/```[\s\S]*?```/g, ' ').replace(/`[^`]*`/g, ' ')
}
