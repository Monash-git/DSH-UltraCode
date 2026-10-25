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

/** Map one session snapshot to the control the composer should show. */
export function controlView(snapshot: Snapshot): ControlView {
  if (snapshot.ultra?.paused === true) return 'play'
  const phase = snapshot.ultra?.run?.phase
  if (snapshot.running || phase === 'running' || phase === 'armed') return 'pause'
  return 'hidden'
}
