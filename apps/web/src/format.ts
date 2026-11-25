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

/** The URL of an image the chat stored in R2. Its key's last segment names the file. */
export const imageUrl = (key: string): string =>
  `/c/media/${encodeURIComponent(key.split("/").at(-1) ?? "")}`;

/** The thread list's group for a time: today, yesterday, or earlier. */
export const dayGroup = (at: number, now = Date.now()): "Today" | "Yesterday" | "Earlier" => {
  const start = new Date(now);
  start.setHours(0, 0, 0, 0);
  const today = start.getTime();
  if (at >= today) return "Today";
  return at >= today - 86_400_000 ? "Yesterday" : "Earlier";
};
