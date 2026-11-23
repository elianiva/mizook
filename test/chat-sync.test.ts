import {
  applyEvent,
  ChatEvent,
  type ChatMessage,
  type ChatState,
  type ThreadSummary,
} from "@mizook/chat-sync";
import { expect, test } from "vite-plus/test";

const agent = { id: "a1", slug: "web", name: "Web", isDefault: false, isWebDefault: true };
const thread: ThreadSummary = {
  id: "t1",
  title: "New chat",
  preview: "",
  created: 1,
  updated: 1,
  agent: { id: agent.id, slug: agent.slug, name: agent.name },
  archived: false,
};
const message: ChatMessage = { id: 7, role: "user", text: "hello", at: 2 };
const base: ChatState = {
  agents: [agent],
  threads: [thread],
  defaultAgent: { slug: agent.slug, name: agent.name },
  transcripts: { [thread.id]: { messages: [], running: false, approvals: [] } },
};

test("a message event appends once and leaves the other transcript fields alone", () => {
  const once = applyEvent(base, ChatEvent.cases.Message.make({ threadId: thread.id, message }));
  const twice = applyEvent(once, ChatEvent.cases.Message.make({ threadId: thread.id, message }));
  expect(once.transcripts[thread.id]?.messages).toEqual([message]);
  expect(twice.transcripts[thread.id]?.messages).toEqual([message]);
  expect(once.transcripts[thread.id]?.running).toBe(false);
});

test("a status event replaces running and approvals together", () => {
  const approval = { id: 3, summary: "Delete the file", match: "", created: 4 };
  const next = applyEvent(
    base,
    ChatEvent.cases.Status.make({ threadId: thread.id, running: true, approvals: [approval] }),
  );
  expect(next.transcripts[thread.id]).toEqual({
    messages: [],
    running: true,
    approvals: [approval],
  });
});

test("a thread event moves the updated thread to the front and keeps its transcript", () => {
  const renamed = { ...thread, title: "Renamed", updated: 5 };
  const next = applyEvent(
    { ...base, threads: [{ ...thread, id: "t2", title: "Old" }, thread] },
    ChatEvent.cases.Thread.make({ thread: renamed }),
  );
  expect(next.threads.map((entry) => entry.id)).toEqual(["t1", "t2"]);
  expect(next.threads[0]?.title).toBe("Renamed");
  expect(next.transcripts[thread.id]).toEqual(base.transcripts[thread.id]);
});

test("an agents event replaces the list and default without touching threads", () => {
  const other = { ...agent, id: "a2", slug: "other", name: "Other", isWebDefault: false };
  const next = applyEvent(
    base,
    ChatEvent.cases.Agents.make({
      agents: [agent, other],
      defaultAgent: { slug: other.slug, name: other.name },
    }),
  );
  expect(next.agents.map((entry) => entry.slug)).toEqual(["web", "other"]);
  expect(next.defaultAgent.slug).toBe("other");
  expect(next.threads).toEqual(base.threads);
});
