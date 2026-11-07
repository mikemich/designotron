// Number keys set opacity like Figma: 1-9 are 10-90 %, 0 is 100 %, and a second digit typed
// within the window makes an exact percent ("0" then "5" is 5 %, "0" then "0" is 0 %, "4" then
// "5" is 45 %). Pure, so the timing rule is unit-tested.

/** How long after a digit a second one still counts as part of the same number. */
export const OPACITY_WINDOW_MS = 500;

export interface PendingDigit {
  digit: number;
  time: number;
}

/** The opacity (0-1) for a digit key, and what to remember for the next key. */
export function nextOpacity(prev: PendingDigit | null, digit: number, now: number): { value: number; pending: PendingDigit | null } {
  if (prev && now - prev.time <= OPACITY_WINDOW_MS) {
    // The pair is complete: the next digit starts a new number.
    return { value: (prev.digit * 10 + digit) / 100, pending: null };
  }
  return { value: digit === 0 ? 1 : digit / 10, pending: { digit, time: now } };
}
