# dsh-ultracode

DSH-native Ultra standing mode, skill autopilot, steer-aware continuation,
pause/resume for root sessions, and the composer play/pause control.

## Install

Build the workspace, then add this package by absolute path in DSH Desktop's
Plugins page. It can be installed without the skills package; Ultra and
pause/resume still work, but there are no adapted skills to autopilot.

## Ultra

- DeepSeek models that support `max` also advertise `Ultra` above `Max` in the
  model selector. The session selection stores `ultra`; every provider request
  is mapped to `max`. No new provider, model, or wire effort is created.
- Selecting Ultra arms a standing mode. The plugin appends a full playbook on
  arm/resume/compaction and a compact reminder on each human turn, telling the
  model to use DSH's built-in `workflow` tool for substantive tasks, return to
  the user between phases, and use the standard quality recipes.
- It does **not** create an autopilot run and does **not** force continuation.
  A simple question stays a simple question. The skill autopilot is separate
  and is driven by `metadata.autopilot`.
- `/ultra on|off|status` is an optional effort-independent toggle;
  `/ultra <task>` is an explicit task entry. The selector is the normal path.
- No default completion guard. If dogfood shows ordinary Ultra tasks stopping
  early, a bounded guard can be added later; the plugin does not silently turn
  Ultra into autopilot.

## Steering

A message sent while a turn is running is delivered at the next model call
(`steer`), not after the whole turn (`queue`), unless the user explicitly chose
Queue. On first load the plugin writes `steer` to `ui-conversation.busyEnter`
only when the user has no explicit setting; an explicit `queue` is preserved.
The setting is **Settings → General → Send behavior while busy**.

The plugin does not implement a second queue. At `agent/turn-stopping` it
skips the autopilot continuation when the inbox already contains user work.

## Turn yield

When an autopilot run's model stops and the only remaining dependency is a
running background job owned by the root session, the run enters `waiting_job`
and the turn ends without a continuation nudge. A job completion notice then
opens a new turn in the same session, the run returns to `running`, and the
round counter advances. A pending user message or a model question wins over a
job wake: the run waits for the human instead. Jobs that are `stopping` or
unowned do not count.

The run's duration budget counts active time only; `waiting_job`,
`waiting_user`, and paused time are excluded. Round and duration caps still
apply, and a run at a cap wraps up instead of yielding into an uncounted turn.

Turn yield relies on `tool-jobs` completing an idle owner with `wakeup`
delivery and an unspent `maxConsecutiveWakes` budget. A settlement that lands
in the driver's retirement window can still strand its notice until the next
user input; that race belongs to DSH's agent loop.

## Status and safe observation

- Every root session gets `session_status`, a generic read-only tool. It reports
  the current turn and step, the autopilot run state and round, the todo summary
  with its last-updated time, the active background jobs owned by that session,
  and the pause state. It folds in-memory session events and the optional job
  registry; it never opens a session archive, a profile directory, or another
  session's log. It is available to root sessions only.
- A one-time generic observation prompt points the model at `session_status`
  and the session-history tools. It states that one frame of a multi-frame
  `.zstd` archive is a partial prefix and is not evidence, that a recognized
  multi-frame format problem must end that line of investigation, and that
  profile directories and `node_modules` must not be enumerated during
  diagnosis. Like the task-state prompt, it is re-anchored once after a
  compaction and contains no ticket, phase, or skill vocabulary.
- The plugin bundle patch also mounts the five shipped model-facing session
  query tools (`session_search`, `session_event_search`, `session_trace`,
  `session_event_trace`, `session_event_read`) in an isolated
  `sessionQuery` group with a lazy `:memory:` index. This is a profile
  composition change only: no DSH server or `app.asar` change is needed. The
  shared base index and the sidebar search keep their own configuration.

## Pause/play

The primary Send/Stop button becomes Pause while a root session is running (or
an autopilot run is waiting on an owned background job) and the draft is
empty; it becomes Play while the session is paused. With text or attachments
the button stays the shipped Send/Steer action, and sending text while paused
clears the pause and starts a new direction. Pause/Play is root-only:
subagents, locked composers, and busy input states keep the default button.

Pause/Stop and crash-interrupted turns are saved durably; a Desktop restart
restores the paused state. Play resumes an autopilot run with a continuation
nudge, or an ordinary interrupted turn with a generic resume prompt. No
automatic resume and no silent spend.

Pause is root-mediated for local subagents. The root writes a durable pause
manifest and sends each live descendant a host control message. At the child's
next `agent/pre-step` the control is consumed before the model sees it, the
child flushes its session, records a checkpoint, acknowledges, and parks with
its turn open; no model request is made while parked. The primary control shows
the acknowledged/total progress while pausing and marks forced stops. A child
that does not acknowledge within the bounded timeout (60 seconds by default) is
stopped through the existing interrupt path and marked forced in the manifest.
Play releases parked turns in place, warm-resumes resident children, and
cold-resumes disposed children through `ctx.subagents`; when cold resume is
unavailable, the manifest carries a restart-from-checkpoint warning. Workflow
children are only ever parked this way, never sent a normal finish message, so
their pending workflow result is not corrupted; a workflow child that was
stopped instead of parked is reported as job-owned and left to its workflow run
rather than independently resumed. Their job ids and owned jobs are recorded in
the manifest for the workflow/bash pause ticket.

The control is a native occupant of DSH's optional
`conversation.input.primary` slot. It renders the shipped primary action
unchanged whenever it does not own the state, does not use DOM/CSS injection,
and adds no second pause button. A DSH build that does not declare that slot
leaves the default Send/Stop button untouched. The Host commands `/pause` and
`/resume` are the underlying actions.

## Session lifecycle

- An Ultra default is carried into a **blank new session** only: a session
  with no `model/selection` and no prior turn. Existing sessions are never
  mutated just because Ultra is the current default; their stored selection,
  pause record, and run record are read as-is.
- Plugin records are written with the ignorable `plugin:ultracode/*` envelope,
  so a harness that does not know them keeps the record without an
  unknown-event error. Old bare `autopilot/run`, `ultracode/mode`, and
  `ultracode/pause` records are still read as a compatibility fallback.
- Disposal is treated as a **hot reload**: the plugin drops only its in-memory
  view. It never cancels a live run or rewrites the model selection from its
  teardown path. A reloaded instance rehydrates runs, pause state, and Ultra
  mode from the live session logs without promoting a running session to
  paused.
- A **true shutdown** is the process ending. The durable run record stays in
  the log; the next time that session is opened, an unfinished run is restored
  as `paused_resume`, and Play resumes it. Nothing resumes automatically.
- **Uninstall:** if a session has Ultra selected, choose Max before disabling
  the plugin. The plugin deliberately does not rewrite selections while it is
  being disposed, because the same path runs on every hot reload. Without the
  plugin, a log that still selects `ultra` has no Ultra effort decorator; pick
  a standard effort to continue that session.

## Cache discipline

Within a run the system prompt, tool declarations, provider, model, and wire
effort stay byte-identical; the plugin only appends messages. Ultra's playbook
and reminders are append-only. The runtime harness asserts the prefix
invariants with a mock adapter.

## Known limits

- Disabling the plugin while a session has Ultra selected requires reselecting
  an effort; the dispose path intentionally leaves the stored selection alone.
- DSH's workflow tool has no resume/journaling, nested workflows, token budget,
  saved workflows, per-agent effort/isolation/agentType, or worktree isolation.
- DSH has no Claude-style usage-limit pause; Ultra can spend more tokens.
- Background workflow jobs are jobs, not autopilot; pausing the agent records
  the job ids in the pause manifest but does not cancel or restart the jobs
  (that is the workflow/bash pause ticket). Pausing while a run waits on a job
  records the pause, but DSH still delivers the job's completion wake; there is
  no wake gate yet.
- The local-child park uses DSH's awaited `agent/pre-step` boundary to hold a
  turn open. It is plugin-only and deliberately not a core suspend gate: an
  in-flight tool still has to settle before the child can reach its park point,
  and a process restart cannot restore a parked in-memory turn (the session
  checkpoint can be cold-resumed instead).
- The plugin detects a live job through the optional `ctx.jobs` service. If the
  composition omits it, turn yield simply does not trigger.
- `session_status` reports the calling root session only. It does not read
  another workspace's session; use the workspace-authorized session-history
  tools for cross-session evidence.
- The session-history tools ship with the DSH installation. The plugin's bundle
  patch mounts them; if a DSH build does not carry
  `@deepseek-ai/dsh-tool-session-query`, the profile layer fails to load that
  row rather than changing core code. Do not also enable the official
  **Session search** bundle: it registers the same five tool names.
- The client bundle is built as a DSH client module. If a packaged Desktop
  build rejects third-party client bundles, the Host pause/resume commands
  remain available; do not patch `app.asar`.
