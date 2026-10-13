/** A time as the user's clock shows it, in their time zone: `Tuesday, 13 October 2026 at 16:05:00 GMT+7`. */
export const formatDate = (date: Date, timeZone: string): string =>
  new Intl.DateTimeFormat("en-GB", { timeZone, dateStyle: "full", timeStyle: "long" }).format(date);
