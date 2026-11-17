export const usd = (amount: number): string => `$${amount.toFixed(amount < 1 ? 4 : 2)}`;

export const count = (value: number): string => value.toLocaleString("en-US");

/** `2026-11-01 00:12`, in UTC, from an ISO timestamp. */
export const dateTime = (iso: string): string => iso.slice(0, 16).replace("T", " ");

export const epochDateTime = (epochMs: number): string =>
  `${dateTime(new Date(epochMs).toISOString())} UTC`;

export const percent = (part: number, whole: number): number =>
  whole <= 0 ? 0 : Math.round((part / whole) * 100);
