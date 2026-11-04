/**
 * The switch window's write bound (DESIGN 9.5; aviary pigeon `legacy::OLD_NOT_AFTER`): every write pigeon sends through
 * its legacy upstream carries the instant (Unix milliseconds, pigeon's clock) past which it must not be applied, as
 * the message field `aviaryNotAfter` (socket) or the header `x-aviary-not-after` (HTTP). pigeon gives the write up at
 * that instant and settles it from the old timeline, so a write that reaches its commit point here later (held by
 * bridge B1 or the old router's relay) is refused, never applied. A message without the field is not bounded (staff
 * tabs never send it). Deleted with the switch window (A6).
 */
export const NOT_AFTER_FIELD = 'aviaryNotAfter';
export const NOT_AFTER_HEADER = 'x-aviary-not-after';

/** The refusal's code (rpc_error / HTTP 409 body). */
export const NOT_AFTER_CODE = 'not_after';

export class NotAfterError extends Error {
  readonly code = NOT_AFTER_CODE;
  constructor() {
    super('the write arrived after its bound');
  }
}

/** True when `value` names an instant that has passed (a number, or a string of digits from a header). */
export function pastNotAfter(value: unknown, now: number = Date.now()): boolean {
  const n = typeof value === 'number' ? value : typeof value === 'string' && /^\d{1,16}$/.test(value) ? Number(value) : NaN;
  return Number.isFinite(n) && now > n;
}
