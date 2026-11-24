import type { AssistantMessage } from "@earendil-works/pi-ai";
import type { EntryRecord, LiveState } from "@earendil-works/pi-durable";

/**
 * What a web turn shows: the text of each assistant message, then of the
 * response still streaming. Thinking and tool calls stay out of it.
 */
export const replyText = (entries: ReadonlyArray<EntryRecord>, live?: LiveState): string => {
  const texts: string[] = [];
  const addText = (message: AssistantMessage) => {
    for (const block of message.content)
      if (block.type === "text" && block.text.trim() !== "") texts.push(block.text.trim());
  };
  for (const entry of entries) {
    const message = entry.model?.[0];
    if (entry.kind === "pi.assistant" && message?.role === "assistant") addText(message);
  }
  const streaming = live?.generation?.message as unknown as AssistantMessage | undefined;
  if (streaming !== undefined) addText(streaming);
  return texts.join("\n\n");
};
