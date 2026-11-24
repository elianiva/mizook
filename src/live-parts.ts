import type { AssistantMessage, ToolResultMessage } from "@earendil-works/pi-ai";
import type { EntryRecord, LiveState } from "@earendil-works/pi-durable";
import type { ChatPart } from "@mizook/chat-sync";
import { clipToolOutput } from "@mizook/memory";

const MAX_TOOL_OUTPUT_CHARS = 4_000;

const textOf = (message: ToolResultMessage): string =>
  message.content.flatMap((block) => (block.type === "text" ? [block.text] : [])).join("");

const inputOf = (args: Record<string, unknown>): string =>
  typeof args["code"] === "string" ? args["code"] : JSON.stringify(args);

/**
 * What a web turn shows: each assistant message's thinking, text and tool calls
 * in the order the model produced them, then the response still streaming. A
 * call has an output once its result entry exists, and the running output of
 * its live slot before that.
 */
export const turnParts = (
  entries: ReadonlyArray<EntryRecord>,
  live?: LiveState,
): ReadonlyArray<ChatPart> => {
  const results = new Map<string, ToolResultMessage>();
  for (const entry of entries) {
    const message = entry.model?.[0];
    if (entry.kind === "pi.tool-result" && message?.role === "toolResult")
      results.set(message.toolCallId, message);
  }
  const running = new Map((live?.tools ?? []).map((slot) => [slot.callId, slot.output]));

  const parts: ChatPart[] = [];
  const addBlocks = (message: AssistantMessage) => {
    for (const block of message.content) {
      if (block.type === "thinking") {
        if (!block.redacted && block.thinking.trim() !== "")
          parts.push({ _tag: "Thinking", text: block.thinking });
      } else if (block.type === "text") {
        if (block.text.trim() !== "") parts.push({ _tag: "Text", text: block.text });
      } else {
        const result = results.get(block.id);
        const output = result === undefined ? running.get(block.id) : textOf(result);
        parts.push({
          _tag: "Tool",
          id: block.id,
          name: block.name,
          input: inputOf(block.arguments),
          ...(output !== undefined && { output: clipToolOutput(output, MAX_TOOL_OUTPUT_CHARS) }),
          ...(result?.isError === true && { failed: true }),
        });
      }
    }
  };

  for (const entry of entries) {
    const message = entry.model?.[0];
    if (entry.kind === "pi.assistant" && message?.role === "assistant") addBlocks(message);
  }
  const streaming = live?.generation?.message as unknown as AssistantMessage | undefined;
  if (streaming !== undefined) addBlocks(streaming);
  return parts;
};

export const textOfParts = (parts: ReadonlyArray<ChatPart>): string =>
  parts.flatMap((part) => (part._tag === "Text" ? [part.text.trim()] : [])).join("\n\n");
