import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, it } from "node:test";
import { chunkText } from "../src/format.ts";
import { Outbox, type OutgoingMessage } from "../src/imessage/outbox.ts";
import { State } from "../src/state.ts";
import { CHIEF, Clock, makeConfig, OWNER, RecordingSender } from "./helpers.ts";

const cleanups: (() => void)[] = [];
afterEach(() => {
  while (cleanups.length) cleanups.pop()!();
});

function harness(start?: Date) {
  const dir = mkdtempSync(join(tmpdir(), "iagents-outbox-"));
  let state = new State(dir);
  const clock = new Clock(start);
  const sender = new RecordingSender();
  const config = makeConfig({ maxMessageLength: 200, quietHours: { start: "22:00", end: "07:00" } });
  const chats = { oneToOneChats: () => [{ guid: "chat", identifier: OWNER, lastAddressedHandle: CHIEF }] };
  const makeOutbox = () => new Outbox({ state, sender, config, chats, now: clock.now });
  let outbox = makeOutbox();
  cleanups.push(() => {
    state.close();
    rmSync(dir, { recursive: true, force: true });
  });
  return {
    get outbox() { return outbox; },
    get state() { return state; },
    sender,
    clock,
    restart() {
      state.close();
      state = new State(dir);
      outbox = makeOutbox();
    },
  };
}

const message: OutgoingMessage = { to: OWNER, botName: "Chief", botAddress: CHIEF, text: "Here is your reply.", proactive: false };

describe("persistent outbox", () => {
  it("retries failed sends with a delay and acknowledges successful delivery", async () => {
    const h = harness();
    const send = h.sender.send.bind(h.sender);
    let attempts = 0;
    h.sender.send = async (target, text) => {
      if (++attempts === 1) throw new Error("Messages unavailable");
      await send(target, text);
    };
    await h.outbox.enqueue(message);
    assert.equal(h.state.deferredMessages().length, 1);
    await h.outbox.flushDeferred();
    assert.equal(attempts, 1);
    h.clock.advance(30_000);
    await h.outbox.flushDeferred();
    assert.deepEqual(h.sender.sent.map((s) => s.text), [message.text]);
    assert.equal(h.state.deferredMessages().length, 0);
  });

  it("resumes a long reply after a restart without repeating successful bubbles", async () => {
    const h = harness();
    const send = h.sender.send.bind(h.sender);
    let attempts = 0;
    h.sender.send = async (target, text) => {
      if (++attempts === 2) throw new Error("Messages unavailable");
      await send(target, text);
    };
    const text = "The detailed research results are ready. ".repeat(20).trim();
    await h.outbox.enqueue({ ...message, text });
    assert.equal(h.sender.sent.length, 1);
    h.restart();
    h.sender.send = send;
    await h.outbox.flushDeferred();
    assert.deepEqual(h.sender.sent.map((s) => s.text), chunkText(text, 200));
    assert.equal(h.state.deferredMessages().length, 0);
  });

  it("keeps quiet-hour messages across restarts and avoids overlapping flushes", async () => {
    const h = harness(new Date(2026, 8, 14, 23, 0));
    await h.outbox.enqueue({ ...message, proactive: true });
    h.restart();
    await h.outbox.flushDeferred();
    assert.equal(h.sender.sent.length, 0);
    assert.equal(h.state.deferredMessages().length, 1);
    await h.outbox.enqueue({ ...message, text: "Immediate reply" });
    assert.equal(h.sender.sent.length, 1);
    h.clock.advance(8 * 60 * 60_000);
    await Promise.all([h.outbox.flushDeferred(), h.outbox.flushDeferred()]);
    assert.deepEqual(h.sender.sent.map((s) => s.text), ["Immediate reply", message.text]);
    assert.equal(h.state.deferredMessages().length, 0);
  });
});
