const clockFormat = new Intl.DateTimeFormat(undefined, {
  hour: "2-digit",
  minute: "2-digit",
});

const dayFormat = new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric" });

export const clock = (at: number): string => clockFormat.format(new Date(at));

export const timeAgo = (at: number): string => {
  const seconds = Math.max(0, Math.floor((Date.now() - at) / 1000));
  if (seconds < 60) return "now";
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h`;
  const days = Math.floor(hours / 24);
  if (days < 7) return `${days}d`;
  return dayFormat.format(new Date(at));
};

/** The sidebar shows one plain line, even when the agent answered in Markdown. */
export const previewText = (text: string): string =>
  text
    .replace(/```[\s\S]*?```/g, "code")
    .replace(/`([^`]*)`/g, "$1")
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/[*_~]/g, "")
    .replace(/^\s{0,3}#{1,6}\s+/gm, "")
    .replace(/^\s{0,3}(?:[-+*]|\d+[.)])\s+/gm, "")
    .replace(/\s+/g, " ")
    .trim();
