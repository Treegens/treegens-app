// Next that keeps bringing the signer back to the same empty field. Usually the field is just waiting for them. But
// when something covers it (two fields of one person stacked, on an envelope sent before that was refused), a finger
// cannot reach it, and Easy reading, which lists every field as an ordinary form, is the way out. No React here.

export const CANNOT_REACH = 'Cannot reach this field? Choose View, then Easy reading, where every field is listed as a form you can fill in.';

/** Counts Next landing on the same field in a row. True from the second time on. */
export function sameFieldAgain(times = 2) {
  let last = '', n = 0;
  return (id: string): boolean => {
    n = id === last ? n + 1 : 1;
    last = id;
    return n >= times;
  };
}
