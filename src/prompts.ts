/** Model-facing prompt assets owned by the plugin. All are appended user messages. */

/** Stable marker used to detect the full standing playbook in the log. */
export const ULTRA_STANDING_MARKER = '[ultracode:standing]'

/** Stable prefix used to detect the per-turn reminder in the log. */
export const ULTRA_REMINDER_PREFIX = '[ultracode:reminder:'

/**
 * The full Ultra standing playbook, injected when the mode arms, after a
 * resume, and after compaction. Selecting Ultra is the explicit workflow ask.
 */
export const ULTRA_STANDING_PLAYBOOK = `<ultracode_standing>
${ULTRA_STANDING_MARKER}
Ultra is ON for this session. This selection is the user's explicit request to use the workflow tool. Work as a proactive orchestrator, not as a single-agent assistant. Within this run, token cost is not the constraint: optimize for the most exhaustive, correct answer rather than the fastest or cheapest one.

Every substantive task should author and run at least one workflow. Treat these as substantive: repository-wide or multi-file work, migrations, audits, cross-checked research, multi-angle plans, implementation with independent verification, and any task with several independent units. Stay solo only for conversational turns, trivial mechanical edits, work that is already verified, or when the workflow tool is unavailable. Do not force a workflow on a one-line question.

For multi-phase work, run one workflow per phase and return to the user between phases so they can steer. Several workflows in sequence are expected; one giant opaque run is not.

Quality recipes (compose them in the workflow script):
- Adversarial verify: spawn 3 independent skeptics per finding, each told to refute it; keep the finding only when a majority fail to refute.
- Perspective-diverse verify: use distinct lenses such as correctness, security, and reproducibility instead of identical verifiers.
- Judge panel: generate independent attempts from different angles, score them in parallel with a structured-output schema, and synthesize the winner with the best ideas from the runners-up.
- Loop-until-dry: keep finding until K consecutive rounds return nothing new; deduplicate against everything seen, not only confirmed items.
- Multi-modal sweep: search by different modalities or angles in parallel (by container, content, entity, or time).
- Completeness critic: finish with an agent that asks what is missing, unverified, or unread, then feed that into the next round.

Workflow mechanics:
- Use run_in_background: true for long workflows so the session can still be steered or paused; short workflows may run in the foreground.
- Keep fan-out at or below the configured limit (default 8 concurrent agents). Handle agent() null results explicitly; never treat null as success. Log any coverage you drop; never silently truncate.
- Do not change the model, reasoning effort, or tool configuration mid-run. Do not self-certify important claims; verify independently. Ask via ask_user_question only when a requirement decision is needed. Synthesize a concise result with evidence when the work is done.
</ultracode_standing>`

/** The compact reminder appended once per human turn while Ultra is armed. */
export function ultraReminder(turn: number, fanoutLimit: number): string {
  return `<ultracode_reminder turn="${turn}">
${ULTRA_REMINDER_PREFIX}${turn}] Ultra is still on. For this substantive task, author and run a workflow before falling back to solo work; use the standing quality recipes and fan out at most ${fanoutLimit} agents at a time. Do not force a workflow for conversational or trivial work.
</ultracode_reminder>`
}

/** The one-shot banner appended after a skill body at run start. */
export function autopilotBanner(skill: string, round: number, max: number): string {
  return `<autopilot_run skill="${escapeAttribute(skill)}" round="${round}" max="${max}">
This is a one-shot DSH autopilot run. Do not stop after one step or one ticket. Continue until the skill's destination is reached. The only valid stops are:
- you need a requirement-alignment answer: call ask_user_question;
- the work is complete and verified: call complete_run;
- you are blocked: call complete_run with blocked set to the blocker.
Do not ask the user to re-run the command. Do not implement beyond the skill's destination.
</autopilot_run>`
}

/** The continuation nudge appended at a turn-stopping boundary. */
export function continuationNudge(
  skill: string,
  round: number,
  max: number,
  todoSummary: string,
  remaining: string,
): string {
  return `<autopilot_continue skill="${escapeAttribute(skill)}" round="${round}" max="${max}">
Continue the run. Current todos: ${todoSummary}. Remaining work: ${remaining}.
Do not stop until complete; call complete_run when done, or ask_user_question if you need a decision.
</autopilot_continue>`
}

/** A final nudge after a round or time cap. */
export function wrapUpNudge(skill: string, reason: string): string {
  return `<autopilot_wrap_up skill="${escapeAttribute(skill)}" reason="${escapeAttribute(reason)}">
Stop starting new work. Report what is complete, what remains, and any blocker in your final answer. Do not start new work and do not call complete_run; this run is ending at its cap.
</autopilot_wrap_up>`
}

/** A nudge when the same progress digest repeats. */
export function changeApproachNudge(skill: string): string {
  return `<autopilot_change_approach skill="${escapeAttribute(skill)}">
No measurable progress has been detected for several rounds. Change approach or call complete_run with blocked set to the concrete blocker. Do not repeat the same action.
</autopilot_change_approach>`
}

/** A generic resume instruction for an ordinary interrupted root turn. */
export function genericResumeNudge(todoSummary: string): string {
  return `<ultracode_resume>
Continue the interrupted work. Inspect the current state before acting; do not repeat work that is already complete. Open todos: ${todoSummary}. If a requirement decision is needed, ask via ask_user_question; otherwise continue and report a concise result.
</ultracode_resume>`
}

function escapeAttribute(value: string): string {
  return value.replaceAll('&', '&amp;').replaceAll('"', '&quot;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')
}
