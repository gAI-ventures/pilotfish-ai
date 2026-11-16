// How a host steers a run while it goes (AgentOptions.control): the loop calls checkpoint() before every model
// turn, and the host answers with what happened meanwhile (messages, a pause, notes). These are the interfaces only;
// a host brings its own implementation (with none, a run is never paused and hears nothing).

/** What the person did while the run was between turns. */
export interface Heard {
  /** Messages the person sent, oldest first. They may add to or change the task. */
  messages: string[];
  /** The run was paused: the person may have used the browser, so the page must be looked at again. */
  tookControl: boolean;
  /** What the host settled with the person meanwhile: notes for the run. */
  notes?: string[];
}

export interface RunControl {
  checkpoint(signal?: AbortSignal): Promise<Heard | null>;
  /** Something waits to be settled with the person at the next checkpoint: the run may not finish yet. */
  readonly gated?: boolean;
  /**
   * Settle the waiting gates now, between checkpoints (the run is waiting on a person and no model turn is near).
   * Their notes reach the run at its next checkpoint.
   */
  runGates?(signal?: AbortSignal): Promise<void>;
  /** Messages the person sent that the run has not read yet: one sent while the person is being asked ends that wait. */
  readonly unread?: number;
}
