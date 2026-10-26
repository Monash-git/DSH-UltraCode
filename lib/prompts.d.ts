/** Model-facing prompt assets owned by the plugin. All are appended user messages. */
/** Stable marker used to detect the full standing playbook in the log. */
export declare const ULTRA_STANDING_MARKER = "[ultracode:standing]";
/** Stable prefix used to detect the per-turn reminder in the log. */
export declare const ULTRA_REMINDER_PREFIX = "[ultracode:reminder:";
/** Stable marker used to inject the generic task-state prompt once per root session. */
export declare const TASK_STATE_MARKER = "[ultracode:task-state]";
/**
 * One-time generic task-state instruction. It is deliberately skill-agnostic:
 * no ticket, phase, or skill name appears here.
 */
export declare const TASK_STATE_PROMPT = "<ultracode_task_state>\n[ultracode:task-state]\nAny multi-step task: keep the todo list current. When the plan changes \u2014 a task is added, completed, reordered, or dropped \u2014 update the todo list in the same step so the user sees current progress. This applies to every task, regardless of its type.\n</ultracode_task_state>";
/** Stable marker used to inject the generic safe-observation prompt once per root session. */
export declare const OBSERVATION_MARKER = "[ultracode:observation]";
/**
 * One-time generic safe-observation instruction. It is deliberately
 * skill-agnostic and names no ticket, phase, or skill concept.
 */
export declare const OBSERVATION_PROMPT = "<ultracode_observation>\n[ultracode:observation]\nFor progress or current-session questions, use the session_status tool: it reports the turn, step, run state, todo summary, active background jobs, and pause state without reading any file.\nWhen you need prior or session evidence, use the session-history tools (session_search, session_event_search, session_trace, session_event_trace, session_event_read) instead of reading raw archives.\nNever decompress a raw session archive such as a .zstd file ad hoc. One frame of a multi-frame archive is only a partial prefix and is not evidence; never conclude from such a read that a session is empty, missing, or a stub. If you recognize a multi-frame or format problem, stop investigating that file. Do not enumerate profile directories or node_modules during diagnosis.\n</ultracode_observation>";
/** The standing reply-first rule shared by the generic autopilot and Ultra assets. */
export declare const REPLY_FIRST_RULE = "Reply first: a direct user question, including a progress question, is answered in the same step before any new diagnostic. Asking for progress does not stop the run; answer, then continue.";
/**
 * The background-job contract shared by the autopilot assets. A live job the
 * run still needs is a valid stop; its completion notice wakes a new turn.
 */
export declare const BACKGROUND_JOB_RULE = "A relevant background job that is still running is a valid stop: stop the turn and let its completion notice resume the run. Do not call job_output with wait:true to sleep; kill jobs you no longer need with job_kill, and do independent work while a job runs.";
/**
 * The full Ultra standing playbook, injected when the mode arms, after a
 * resume, and after compaction. Selecting Ultra is the explicit workflow ask.
 */
export declare const ULTRA_STANDING_PLAYBOOK = "<ultracode_standing>\n[ultracode:standing]\nUltra is ON for this session. This selection is the user's explicit request to use the workflow tool. Work as a proactive orchestrator, not as a single-agent assistant. Within this run, token cost is not the constraint: optimize for the most exhaustive, correct answer rather than the fastest or cheapest one.\n\nReply first: a direct user question, including a progress question, is answered in the same step before any new diagnostic. Asking for progress does not stop the run; answer, then continue.\n\nEvery substantive task should author and run at least one workflow. Treat these as substantive: repository-wide or multi-file work, migrations, audits, cross-checked research, multi-angle plans, implementation with independent verification, and any task with several independent units. Stay solo only for conversational turns, trivial mechanical edits, work that is already verified, or when the workflow tool is unavailable. Do not force a workflow on a one-line question.\n\nFor multi-stage work, run one workflow per stage and return to the user between stages so they can steer. Several workflows in sequence are expected; one giant opaque run is not.\n\nQuality recipes (compose them in the workflow script):\n- Adversarial verify: spawn 3 independent skeptics per finding, each told to refute it; keep the finding only when a majority fail to refute.\n- Perspective-diverse verify: use distinct lenses such as correctness, security, and reproducibility instead of identical verifiers.\n- Judge panel: generate independent attempts from different angles, score them in parallel with a structured-output schema, and synthesize the winner with the best ideas from the runners-up.\n- Loop-until-dry: keep finding until K consecutive rounds return nothing new; deduplicate against everything seen, not only confirmed items.\n- Multi-modal sweep: search by different modalities or angles in parallel (by container, content, entity, or time).\n- Completeness critic: finish with an agent that asks what is missing, unverified, or unread, then feed that into the next round.\n\nWorkflow mechanics:\n- Use run_in_background: true for long workflows so the session can still be steered or paused; short workflows may run in the foreground.\n- Keep fan-out at or below the configured limit (default 8 concurrent agents). Handle agent() null results explicitly; never treat null as success. Log any coverage you drop; never silently truncate.\n- Do not change the model, reasoning effort, or tool configuration mid-run. Do not self-certify important claims; verify independently. Ask via ask_user_question only when a requirement decision is needed. Synthesize a concise result with evidence when the work is done.\n</ultracode_standing>";
/** The compact reminder appended once per human turn while Ultra is armed. */
export declare function ultraReminder(turn: number, fanoutLimit: number): string;
/** The one-shot banner appended after a skill body at run start. */
export declare function autopilotBanner(skill: string, round: number, max: number): string;
/** The continuation nudge appended at a turn-stopping boundary. */
export declare function continuationNudge(skill: string, round: number, max: number, todoSummary: string, remaining: string): string;
/** A final nudge after a round or time cap. */
export declare function wrapUpNudge(skill: string, reason: string): string;
/** A nudge when the same progress digest repeats. */
export declare function changeApproachNudge(skill: string): string;
/** A generic resume instruction for an ordinary interrupted root turn. */
export declare function genericResumeNudge(todoSummary: string): string;
//# sourceMappingURL=prompts.d.ts.map