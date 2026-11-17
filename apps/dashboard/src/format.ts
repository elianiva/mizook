export const usd = (amount: number): string => `$${amount.toFixed(amount < 1 ? 4 : 2)}`;

export const count = (value: number): string => value.toLocaleString("en-US");

/** `2026-11-01 00:12`, in UTC, from an ISO timestamp. */
export const dateTime = (iso: string): string => iso.slice(0, 16).replace("T", " ");

export const epochDateTime = (epochMs: number): string =>
  `${dateTime(new Date(epochMs).toISOString())} UTC`;

export const percent = (part: number, whole: number): number =>
  whole <= 0 ? 0 : Math.round((part / whole) * 100);

/** How long ago, in the largest unit that fits: `just now`, `5 min ago`, `3 h ago`, `2 d ago`. */
export const ago = (epochMs: number, now: number = Date.now()): string => {
  const seconds = Math.max(0, Math.round((now - epochMs) / 1000));
  if (seconds < 60) {
    return "just now";
  }
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) {
    return `${minutes} min ago`;
  }
  const hours = Math.floor(minutes / 60);
  return hours < 48 ? `${hours} h ago` : `${Math.floor(hours / 24)} d ago`;
};
