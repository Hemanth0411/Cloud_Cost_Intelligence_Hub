/**
 * Two facts about the data that every screen shares, kept in one
 * place so the chrome can state them.
 *
 *  * `asOf` -- the finish time of the last successful ingest, which
 *    every cost response carries. It is NOT "now": cost data lags
 *    8-24h and finalises monthly, so a header that implies live
 *    figures is wrong by a day. It is null until an ingest has run.
 *  * `restricted` -- the API answered 403. That is a designed state
 *    ("a user with no grants receives zero rows"), so the screens
 *    render empty rather than erroring, and this is what lets the
 *    shell say WHY they are empty instead of leaving someone to
 *    conclude the product is broken.
 *
 * A two-field store rather than a context because the producers are
 * plain async functions in `cost-service` and the consumer is the
 * sidebar, which is nowhere near them in the tree. Threading it
 * through would mean every view returning an envelope it does not
 * use.
 */

export interface DataStatus {
  asOf: string | null;
  restricted: boolean;
}

let status: DataStatus = { asOf: null, restricted: false };
const listeners = new Set<() => void>();

function emit(next: DataStatus): void {
  // The snapshot identity must only change when a VALUE changes:
  // useSyncExternalStore re-renders on every new object, and a fresh
  // one per read would loop.
  if (next.asOf === status.asOf && next.restricted === status.restricted) return;
  status = next;
  for (const listener of listeners) listener();
}

export function reportAsOf(asOf: string | null): void {
  if (asOf === null) return; // "this response had none" is not "we lost it"
  emit({ ...status, asOf });
}

export function reportRestricted(restricted: boolean): void {
  emit({ ...status, restricted });
}

export function getDataStatus(): DataStatus {
  return status;
}

/** Stable across the server render, where nothing has been reported. */
const SERVER_STATUS: DataStatus = { asOf: null, restricted: false };
export function getServerDataStatus(): DataStatus {
  return SERVER_STATUS;
}

export function subscribeDataStatus(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}
