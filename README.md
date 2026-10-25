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

## Pause/play

The composer activity seat shows a pause button while a root session is
running and a play button while it is paused. Pause/Stop and crash-interrupted
turns are saved durably; a Desktop restart restores the paused state. Play
resumes an autopilot run with a continuation nudge, or an ordinary interrupted
turn with a generic resume prompt. No automatic resume and no silent spend.

The control is a native slot contribution; it does not replace the Send/Stop
button and does not use DOM/CSS injection. The Host commands `/pause` and
`/resume` are the underlying actions.

## Cache discipline

Within a run the system prompt, tool declarations, provider, model, and wire
effort stay byte-identical; the plugin only appends messages. Ultra's playbook
and reminders are append-only. The runtime harness asserts the prefix
invariants with a mock adapter.

## Known limits

- Disabling the plugin while a session has Ultra selected requires reselecting
  an effort; the dispose path is best-effort.
- DSH's workflow tool has no resume/journaling, nested workflows, token budget,
  saved workflows, per-agent effort/isolation/agentType, or worktree isolation.
- DSH has no Claude-style usage-limit pause; Ultra can spend more tokens.
- Background workflow jobs are jobs, not autopilot; pausing the agent does not
  cancel a running job.
- The client bundle is built as a DSH client module. If a packaged Desktop
  build rejects third-party client bundles, the Host pause/resume commands
  remain available; do not patch `app.asar`.
