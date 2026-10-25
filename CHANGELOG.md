# Changelog

## Unreleased

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
