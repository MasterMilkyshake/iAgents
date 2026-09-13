import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { nonceFor } from "../src/grokbot/bridge.ts";
import { chronological, extractEntries, parseEntry, TranscriptTracker, type TranscriptEntry } from "../src/grokbot/transcript.ts";

describe("extractEntries", () => {
  it("finds entry arrays under common keys and wrappers", () => {
    assert.equal(extractEntries({ entries: [1, 2] }).length, 2);
    assert.equal(extractEntries({ messages: [1] }).length, 1);
    assert.equal(extractEntries({ transcript: { items: [1, 2, 3] } }).length, 3);
    assert.equal(extractEntries([1]).length, 1);
    assert.equal(extractEntries({ nothing: true }).length, 0);
  });
});

describe("parseEntry", () => {
  it("reads a plain assistant message", () => {
    const entry = parseEntry({ id: "m1", role: "assistant", text: "Hi", status: "completed" });
    assert.deepEqual(entry, { id: "m1", role: "bot", text: "Hi", complete: true, author: "", needsApproval: false });
  });

  it("reads speaker from type or nested author and text from content parts", () => {
    const entry = parseEntry({
      messageId: "m2",
      type: "agent_message",
      author: { name: "Researcher" },
      content: [{ type: "text", text: "Part one" }, { type: "tool_use", name: "search" }, { type: "output_text", text: "Part two" }],
    });
    assert.equal(entry?.role, "bot");
    assert.equal(entry?.text, "Part one\nPart two");
    assert.equal(entry?.author, "Researcher");
  });

  it("treats tool calls, thinking, and status updates as non-messages", () => {
    for (const raw of [
      { id: "t", role: "assistant", type: "tool_call", text: "search(...)" },
      { id: "r", type: "reasoning", text: "hmm" },
      { id: "s", kind: "status", text: "Working" },
    ]) {
      assert.equal(parseEntry(raw)?.role, "other", JSON.stringify(raw));
    }
  });

  it("recognizes user messages and streaming state", () => {
    assert.equal(parseEntry({ id: "u", sender: "user", text: "hello" })?.role, "user");
    assert.equal(parseEntry({ id: "b", role: "assistant", text: "par", isStreaming: true })?.complete, false);
    assert.equal(parseEntry({ id: "b", role: "assistant", text: "partial", status: "in_progress" })?.complete, false);
    assert.equal(parseEntry({ id: "b", role: "assistant", text: "?" })?.complete, null);
  });

  it("flags approval requests", () => {
    assert.equal(parseEntry({ id: "a", role: "assistant", type: "approval_request", text: "Send the email?" })?.needsApproval, true);
  });

  it("makes an id that survives the text growing while it streams", () => {
    const start = "A reply long enough that its first sixty-four characters stay the same";
    const a = parseEntry({ role: "assistant", createdAt: "2026-09-14T12:00:00Z", text: start });
    const b = parseEntry({ role: "assistant", createdAt: "2026-09-14T12:00:00Z", text: `${start}, then more text` });
    assert.ok(a?.id.startsWith("h:"));
    assert.equal(a?.id, b?.id);
  });
});

function bot(id: string, text: string, complete: boolean | null = null): TranscriptEntry {
  return { id, role: "bot", text, complete, author: "", needsApproval: false };
}

describe("TranscriptTracker", () => {
  const never = () => false;

  it("releases explicitly complete entries immediately", () => {
    const tracker = new TranscriptTracker(2000);
    assert.deepEqual(tracker.ready([bot("a", "done", true)], 0, never).map((e) => e.id), ["a"]);
  });

  it("waits for text without a completion flag to settle", () => {
    const tracker = new TranscriptTracker(2000);
    assert.equal(tracker.ready([bot("a", "Hel")], 0, never).length, 0);
    assert.equal(tracker.ready([bot("a", "Hello wor")], 1000, never).length, 0);
    assert.equal(tracker.ready([bot("a", "Hello world")], 2000, never).length, 0);
    assert.equal(tracker.ready([bot("a", "Hello world")], 3500, never).length, 0);
    assert.deepEqual(tracker.ready([bot("a", "Hello world")], 4000, never).map((e) => e.text), ["Hello world"]);
    assert.ok(!tracker.hasPending());
  });

  it("treats an entry followed by anything as finished", () => {
    const tracker = new TranscriptTracker(60_000);
    const other: TranscriptEntry = { id: "tool", role: "other", text: "", complete: null, author: "", needsApproval: false };
    assert.deepEqual(tracker.ready([bot("a", "Let me check"), other], 0, never).map((e) => e.id), ["a"]);
  });

  it("keeps order: a message still streaming holds back later ones", () => {
    const tracker = new TranscriptTracker(2000);
    assert.equal(tracker.ready([bot("a", "writing", false), bot("b", "later", true)], 0, never).length, 0);
    assert.deepEqual(tracker.ready([bot("a", "written", true), bot("b", "later", true)], 1000, never).map((e) => e.id), ["a", "b"]);
  });

  it("gives up waiting on a stuck streaming flag", () => {
    const tracker = new TranscriptTracker(2000, 10_000);
    assert.equal(tracker.ready([bot("a", "stuck", false)], 0, never).length, 0);
    assert.equal(tracker.ready([bot("a", "stuck", false)], 10_000, never).length, 1);
  });

  it("skips seen entries and non-bot entries", () => {
    const tracker = new TranscriptTracker(0);
    const user: TranscriptEntry = { id: "u", role: "user", text: "hi", complete: true, author: "", needsApproval: false };
    assert.deepEqual(tracker.ready([bot("a", "old", true), user, bot("b", "new", true)], 0, (id) => id === "a").map((e) => e.id), ["b"]);
  });
});

describe("chronological", () => {
  it("puts newest-first transcripts back in order when entries have timestamps", () => {
    const raw = [
      { id: "c", role: "assistant", text: "third", createdAt: "2026-09-14T12:00:03Z" },
      { id: "b", role: "assistant", text: "second", createdAt: 1789387202 },
      { id: "a", role: "user", text: "first", createdAt: "2026-09-14T12:00:01Z" },
    ];
    const entries = chronological(raw.map((r) => parseEntry(r)!));
    assert.deepEqual(entries.map((e) => e.id), ["a", "b", "c"]);
  });

  it("keeps the API's order when any timestamp is missing", () => {
    const entries = [parseEntry({ id: "x", role: "assistant", text: "1", createdAt: 2 })!, parseEntry({ id: "y", role: "assistant", text: "2" })!];
    assert.deepEqual(chronological(entries).map((e) => e.id), ["x", "y"]);
  });
});

describe("nonceFor", () => {
  it("is a deterministic v5-style UUID", () => {
    const nonce = nonceFor("ABC-123");
    assert.match(nonce, /^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    assert.equal(nonce, nonceFor("ABC-123"));
    assert.notEqual(nonce, nonceFor("ABC-124"));
  });
});
