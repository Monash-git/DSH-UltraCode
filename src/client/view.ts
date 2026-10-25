/** Pure view-model for the composer pause/play control. */

export interface UltraView {
  readonly paused?: boolean
  readonly reason?: string | null
  readonly run?: { readonly phase?: string } | null
}

export interface Snapshot {
  readonly running: boolean
  readonly ultra: UltraView | undefined
}

export type ControlView = 'pause' | 'play' | 'hidden'

export const EMPTY: Snapshot = { running: false, ultra: undefined }

/** Whether the run is idle only because an owned background job is live. */
export function waitingOnJob(snapshot: Snapshot): boolean {
  return snapshot.ultra?.run?.phase === 'waiting_job'
}

/** Map one session snapshot to the control the composer should show. */
export function controlView(snapshot: Snapshot): ControlView {
  if (snapshot.ultra?.paused === true) return 'play'
  const phase = snapshot.ultra?.run?.phase
  // Waiting on a job is an idle turn but a live run: pause stays available so
  // the user can stop the session without first waiting for the job.
  if (snapshot.running || phase === 'running' || phase === 'armed' || phase === 'waiting_job') return 'pause'
  return 'hidden'
}
