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

Completion wakes are gated while paused. A background job notice, a subagent
settlement, or any other non-human input claimed at a root `agent/pre-step` is
captured verbatim as a durable `plugin:ultracode/wake-hold` record and the step
is rejected, so the turn closes without a model request and no work starts.
Play replays every unreleased hold into the resume batch and records a durable
release. Text sent while paused cancels the pause and joins any held wakes to
the new direction instead of dropping them. Holds survive a hot reload and a
process restart; a restored pause always shows Play and never resumes itself.
When a pause is restored after a process restart, its manifest says that the
recorded background jobs did not survive and must be restarted from the saved
plan or checkpoint.

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
their pending workflow result is not corrupted.

Workflow and bash jobs have no pause primitive. After the child park drain,
pause stops every live workflow/bash/pwsh job through the host jobs service and
waits a short bounded drain for settlement. The manifest records each job's
kind, label, owner, status, captured output paths, and disposition. A job that
cannot be stopped is recorded as `stop-failed` with a visible warning and is
never reported as paused or stopped; pause does not silently leave background
work spending. A workflow run is captured with its original script (the saved
plan), the job's output paths, the workspace, and every member child Session
id. Play never claims a run-level resume: it sends the root a restart
instruction that restarts workflow work from the saved plan/artifacts and
re-runs a stopped bash command only if still needed. The primary control shows
the restart warning, and `/resume` reports the same outcome.

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
- Background workflow jobs are jobs, not autopilot. Pause stops them after a
  bounded drain and Play restarts workflow work from the saved plan/artifacts
  and member sessions; the DSH workflow engine has no journal, so run-level
  resume is not available. If a job cannot be stopped, the manifest and UI show
  a `stop-failed` warning instead of claiming a pause. A completion wake while
  paused is held durably and released only by Play. After a process restart the
  recorded jobs no longer exist, and the pause reports that they must be
  restarted from the saved plan or checkpoint.
- The local-child park uses DSH's awaited `agent/pre-step` boundary to hold a
  turn open. It is plugin-only and deliberately not a core suspend gate: an
  in-flight tool still has to settle before the child can reach its park point,
  and a process restart cannot restore a parked in-memory turn (the session
  checkpoint can be cold-resumed instead). Unloading the plugin cancels a
  parked child's turn through the normal interrupt path instead of releasing
  it, so a reload never resumes paused work; Play warm-resumes the child from
  its checkpoint.
- The root wake gate also uses `agent/pre-step`: DSH opens the wake's turn
  boundary and claims the notice, then the plugin records the notice durably
  and rejects the step before any model request. If the process crashes between
  the claim and the hold flush, that notice can be lost; the session still
  reopens paused. A crash after Play delivers a held notice but before its
  release record is flushed can replay the notice once more. Neither case
  starts work without Play.
- Pausing while a run is waiting on a background job keeps the run paused when
  the job settles; Play releases the held notice and continues the run. The
  plugin cannot stop an in-flight tool, so a wake that was already claimed
  inside a running tool chain is delivered by that turn rather than held.
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
