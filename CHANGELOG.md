# Changelog

## Unreleased

- Made pause durable across reload and process restart with a completion-wake
  gate. A background job notice, subagent settlement, or other non-human wake
  claimed while paused is stored verbatim as a `plugin:ultracode/wake-hold`
  record and the step is rejected, so no model request is made; Play replays
  every unreleased hold and records a durable release. Text sent while paused
  cancels the pause and releases held wakes into the new direction. A pause
  restored after a restart reports that its background jobs did not survive
  and must be restarted from the saved plan or checkpoint.
- Pause now stops workflow and bash/pwsh background jobs instead of leaving
  them running. After the child park drain, the coordinator requests a kill
  through the host jobs service and waits a short bounded drain for
  settlement. The pause manifest captures each workflow run's original script
  (the saved plan), output paths, workspace, and member child Session ids, and
  records every job's disposition. A failed stop is a visible `stop-failed`
  warning and never a paused/stopped claim. Play sends the root a restart
  instruction that rebuilds workflow work from the saved plan/artifacts and
  re-runs stopped bash work only if needed; it does not claim run-level resume.
  The primary control and `/resume` surface the restart warning.
- Added root-mediated pause for local subagents. Pause now writes a durable
  manifest and sends each live descendant a host pre-step park control; the
  child flushes its session, records a checkpoint, acknowledges, and keeps its
  turn open without a model request. The root waits a bounded time for
  acknowledgments, interrupts non-acknowledging children and marks them forced,
  and shows acknowledged/total plus forced labels on the primary control. Play
  releases parked children, warm-resumes resident stopped children, and
  cold-resumes disposed children through `ctx.subagents`, warning when a child
  must restart from its checkpoint. Workflow children are parked only through
  the host gate (never sent a finish message); job ids are recorded for the
  workflow/bash ticket. Sending text while paused cancels the pause and
  releases parked work.
- Replaced the activity-seat pause/play button with the primary composer
  action: with an empty draft, the main Send/Stop button becomes Pause while a
  root session runs or waits on a background job, and Play while paused. Text
  keeps the shipped Send/Steer action, and sending while paused clears the
  pause. The occupant uses DSH's `conversation.input.primary` slot and the
  existing `/pause` and `/resume` Host commands; it renders the default action
  unchanged for subagents, locked sessions, and states it does not own.
- Added autopilot turn yield: a run whose only remaining dependency is an
  owned running background job enters `waiting_job`, ends the turn without a
  continuation nudge, and resumes on the job's completion notice. Duration
  caps count active time only, and the prompt contract forbids blocking
  `job_output` sleeps.
- Added the generic read-only `session_status` root-session tool (turn, step,
  run state, todo summary and last-updated time, active owned jobs, pause).
- Added a one-time safe-observation prompt: use status/history tools, treat a
  one-frame `.zstd` read as partial evidence, stop on a multi-frame format
  problem, and do not enumerate profiles or `node_modules`.
- The bundle patch now mounts the shipped session-history tools in an isolated
  lazy session-query group, with no DSH core or `app.asar` change.
- Carry an Ultra default only into blank new sessions; existing sessions
  without a selection are no longer mutated.
- Treat plugin disposal as a hot reload: live runs and model selections survive,
  and a reloaded instance rehydrates its view from the live session logs.
- Keep reading legacy bare plugin records inside the ignorable envelope.
- Cover blank/new carry, existing-session non-mutation, old-log load, and
  unload/reload in the unit and runtime suites.

## 0.2.0

- Added the selector-level Ultra tier for DeepSeek models (`ultra` persisted,
  `max` on the wire).
- Added the Ultra standing playbook and per-turn compact reminder, including
  the standard workflow quality recipes.
- Decoupled selector Ultra from autopilot; skill autopilot remains driven by
  `metadata.autopilot`.
- Added steer-aware autopilot continuation and the one-time busy-enter default.
- Added durable pause/resume for every root session, the `ultracode`
  projection, `/pause` and `/resume`, and the composer activity play/pause
  control.
- Added the DSH client module bundle and locale dictionaries.
