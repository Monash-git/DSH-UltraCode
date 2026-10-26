/** Pure detection helpers for user-invoked skills and the Ultracode keyword. */
import type { UserMessage } from '@deepseek-ai/dsh-llm';
/** Return the kebab-case skill name from a leading `/name` user message, if any. */
export declare function findSkillInvocation(messages: readonly UserMessage[]): string | undefined;
/** Whether a user message contains a standalone `ultracode` token outside code. */
export declare function hasUltracodeToken(messages: readonly UserMessage[]): boolean;
/** Whether any message came from the human user. */
export declare function hasUserMessage(messages: readonly UserMessage[]): boolean;
/** Join one message's text blocks. */
export declare function textOf(message: UserMessage): string;
/** Remove fenced/inline code and quoted strings so keyword detection ignores examples. */
export declare function stripCode(text: string): string;
//# sourceMappingURL=detect.d.ts.map