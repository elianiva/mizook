export const formatDate = (date: Date, timeZone: string): string =>
  new Intl.DateTimeFormat("en-GB", { timeZone, dateStyle: "full", timeStyle: "long" }).format(date);
