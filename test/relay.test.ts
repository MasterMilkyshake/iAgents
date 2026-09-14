import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { setImmediate as nextTurn, setTimeout as delay } from "node:timers/promises";
import { ChatDb } from "../src/imessage/chatdb.ts";
import { Relay } from "../src/relay.ts";
import { State } from "../src/state.ts";
import { CHIEF, Clock, DEV, FakeGrokBot, FakeMessages, makeConfig, OWNER, RecordingSender } from "./helpers.ts";

type Harness = ReturnType<typeof harness>;
const cleanups: (() => void)[] = [];
afterEach(() => {
  while (cleanups.length) cleanups.pop()!();
});

function harness(configOverrides: Record<string, unknown> = {}, start?: Date) {
  const fake = new FakeMessages();
  const messages = new ChatDb(fake.path);
  const clock = new Clock(start);
  const grok = new FakeGrokBot();
  const sender = new RecordingSender();
  const state = new State(":memory:");
  // The watcher watches config.chatDbPath, so it must be the same database the store reads.
  const config = makeConfig({ chatDbPath: fake.path, ...configOverrides });
  const relay = new Relay({ config, messages, state, sender, grokBot: grok, now: clock.now });
  cleanups.push(() => {
    messages.close();
    state.close();
    fake.close();
  });
  return {
    fake,
    messages,
    clock,
    grok,
    sender,
    state,
    config,
    relay,
    /** You texting `to` from your phone, right now on the test clock. */
    text(to: string, body: string, extra: Record<string, unknown> = {}) {
      return fake.receive({ to, text: body, at: clock.now(), ...extra });
    },
    async step(ms = 0) {
      clock.advance(ms);
      await relay.tick();
      await relay.idle();
    },
    /** Enough polls for a new bot message to be noticed and, once its text stops changing, relayed. */
    async settle() {
      for (let i = 0; i < 4; i++) await this.step(3000);
    },
    texts: () => sender.sent.map((s) => s.text),
  };
}

async function started(h: Harness): Promise<Harness> {
  await h.relay.start();
  return h;
}

describe("Relay", () => {
  it("keeps receiving prompts and polling healthy bots while another transcript stalls", async () => {
    const h = await started(harness());
    const blocked = Promise.withResolvers<void>();
    const read = h.grok.transcriptTail.bind(h.grok);
    let slowReads = 0;
    h.grok.transcriptTail = async (id, limit) => {
      if (id === "bot-chief") {
        slowReads++;
        await blocked.promise;
      }
      return read(id, limit);
    };
    try {
      h.grok.reply("bot-dev", "ready", "Ready", { done: true });
      const tick = h.relay.tick();
      assert.equal(await Promise.race([tick.then(() => true), nextTurn().then(() => false)]), true);
      await nextTurn();
      assert.deepEqual(h.texts(), ["[Dev] Ready"]);

      h.text(DEV, "Keep working");
      await h.relay.tick();
      await nextTurn();
      assert.deepEqual(h.grok.prompts.map((p) => p.prompt), ["Keep working"]);
      for (let i = 0; i < 3; i++) {
        h.clock.advance(5000);
        await h.relay.tick();
        await nextTurn();
      }
      assert.equal(slowReads, 1, "only one in-flight transcript read per bot");
      assert.equal(h.sender.sent.length, 1, "completed replies aren't duplicated by subsequent ticks");
    } finally {
      blocked.resolve();
      await h.relay.idle();
    }
  });

  it("keeps receiving prompts while Messages.app is slow without duplicating queued sends", async () => {
    const h = await started(harness());
    const blocked = Promise.withResolvers<void>();
    const send = h.sender.send.bind(h.sender);
    let sends = 0;
    h.sender.send = async (target, text) => {
      sends++;
      await blocked.promise;
      await send(target, text);
    };
    try {
      h.text(CHIEF, "/ping");
      await h.relay.tick();
      await nextTurn();
      h.text(DEV, "Work while the reply is being sent");
      const tick = h.relay.tick();
      assert.equal(await Promise.race([tick.then(() => true), nextTurn().then(() => false)]), true);
      await nextTurn();
      assert.equal(h.grok.prompts.length, 1);
      assert.equal(sends, 1);
    } finally {
      blocked.resolve();
      await h.relay.idle();
    }
    assert.equal(h.sender.sent.length, 1);
    assert.equal(h.state.deferredMessages().length, 0);
  });

  it("keeps prompts ordered within a bot while allowing another bot to proceed", async () => {
    const h = await started(harness());
    const blocked = Promise.withResolvers<void>();
    const send = h.grok.sendPrompt.bind(h.grok);
    const attempts: string[] = [];
    h.grok.sendPrompt = async (id, text, nonce) => {
      attempts.push(text);
      if (text === "first") await blocked.promise;
      await send(id, text, nonce);
    };
    try {
      h.text(CHIEF, "first");
      h.text(CHIEF, "second");
      h.text(DEV, "independent");
      await h.relay.tick();
      await nextTurn();
      assert.deepEqual(attempts, ["first", "independent"]);
      assert.deepEqual(h.grok.prompts.map((p) => p.prompt), ["independent"]);
    } finally {
      blocked.resolve();
      await h.relay.idle();
    }
    assert.deepEqual(h.grok.prompts.map((p) => p.prompt), ["independent", "first", "second"]);
  });

  it("runs the message loop during slow startup and drains queued work on shutdown", async () => {
    const h = harness();
    const blocked = Promise.withResolvers<void>();
    const delivered = Promise.withResolvers<void>();
    const controller = new AbortController();
    const list = h.grok.listBots.bind(h.grok);
    const send = h.sender.send.bind(h.sender);
    let listings = 0;
    h.grok.listBots = async () => {
      listings++;
      await blocked.promise;
      return list();
    };
    h.sender.send = async (target, text) => {
      await send(target, text);
      delivered.resolve();
    };
    const running = h.relay.run(controller.signal);
    try {
      h.text(CHIEF, "/ping");
      assert.equal(await Promise.race([delivered.promise.then(() => true), delay(2000, false, { ref: false })]), true,
        "the actual run loop must answer /ping before the gateway connects");
      h.text(CHIEF, "queued during startup");
      await h.relay.tick();
      await nextTurn();
      assert.equal(listings, 1, "startup and incoming prompts share one bot lookup");
    } finally {
      controller.abort();
      blocked.resolve();
      await running;
    }
    assert.deepEqual(h.grok.prompts.map((p) => p.prompt), ["queued during startup"]);
    assert.equal(h.state.deferredMessages().length, 0);
  });

  it("shares baseline reads between startup, incoming prompts, and transcript polls", async () => {
    const h = harness();
    const blocked = Promise.withResolvers<void>();
    const read = h.grok.transcriptTail.bind(h.grok);
    const reads: string[] = [];
    h.grok.transcriptTail = async (id, limit) => {
      reads.push(id);
      if (id === "bot-chief") await blocked.promise;
      return read(id, limit);
    };
    const starting = h.relay.start();
    try {
      await nextTurn();
      assert.deepEqual(reads.sort(), ["bot-chief", "bot-dev"], "independent baselines start concurrently");
      h.text(CHIEF, "hello");
      await h.relay.tick();
      await nextTurn();
      assert.equal(reads.filter((id) => id === "bot-chief").length, 1);
      assert.equal(h.grok.prompts.length, 0, "wait for baseline before sending a new prompt");
    } finally {
      blocked.resolve();
      await starting;
      await h.relay.idle();
    }
    assert.deepEqual(h.grok.prompts.map((p) => p.prompt), ["hello"]);
  });

  it("sends a finished reply on the first read, without waiting for it to settle", async () => {
    const h = await started(harness({ poll: {} }));
    h.text(CHIEF, "hello");
    await h.step();
    // Grok Bot writes a send-message in one go, so there is nothing to wait for.
    h.grok.reply("bot-chief", "a", "Hello back");
    await h.step(2000);
    assert.deepEqual(h.texts(), ["Hello back"]);
  });

  it("releases a message of unstated completeness at the settling deadline", async () => {
    const h = await started(harness({ poll: {} }));
    h.text(CHIEF, "hello");
    await h.step();
    h.grok.agentMessage("bot-chief", "a", "Hello back");
    await h.step(2000); // first observation
    await h.step(2000); // not yet settled
    assert.equal(h.sender.sent.length, 0);
    await h.step(500); // 2.5s after the first observation, before the next regular poll
    assert.deepEqual(h.texts(), ["Hello back"]);
  });

  it("checks for a fresh reply promptly after an older in-flight read finishes", async () => {
    const h = await started(harness({ poll: {} }));
    const blocked = Promise.withResolvers<void>();
    const read = h.grok.transcriptTail.bind(h.grok);
    h.grok.transcriptTail = async (id, limit) => {
      const snapshot = await read(id, limit);
      if (id === "bot-chief") await blocked.promise;
      return snapshot;
    };
    try {
      await h.relay.tick();
      await nextTurn();
      h.text(CHIEF, "hello");
      await h.relay.tick();
      await nextTurn();
      h.grok.reply("bot-chief", "a", "An instant reply", { done: true });
    } finally {
      blocked.resolve();
      await h.relay.idle();
      h.grok.transcriptTail = read;
    }
    await h.step(500);
    assert.deepEqual(h.texts(), ["An instant reply"]);
  });

  it("backs off failed transcript reads instead of retrying an expired settling deadline every tick", async () => {
    const h = await started(harness({ poll: {} }));
    h.text(CHIEF, "hello");
    await h.step();
    h.grok.reply("bot-chief", "a", "A settled reply");
    await h.step(2000);
    const read = h.grok.transcriptTail.bind(h.grok);
    let failures = true;
    let reads = 0;
    h.grok.transcriptTail = async (id, limit) => {
      if (id === "bot-chief") {
        reads++;
        if (failures) throw new Error("temporarily unavailable");
      }
      return read(id, limit);
    };
    await h.step(2500);
    assert.equal(reads, 1);
    await h.step(500);
    await h.step(500);
    assert.equal(reads, 1);
    await h.step(1000);
    assert.equal(reads, 2);
    await h.step(2000);
    assert.equal(reads, 2, "the second failure waits four seconds");
    await h.step(2000);
    assert.equal(reads, 3);
    failures = false;
    await h.step(8000);
    assert.deepEqual(h.texts(), ["A settled reply"]);
    await h.step(2000);
    assert.equal(reads, 5, "successful reads restore normal active polling");
  });

  it("routes swipe-replies even when the sent bubble appears before the send call returns", async () => {
    const h = await started(harness());
    h.text(CHIEF, "Brief me");
    await h.step();
    h.text(DEV, "Work on this");
    await h.step();
    const blocked = Promise.withResolvers<void>();
    const send = h.sender.send.bind(h.sender);
    let bubble = "";
    h.sender.send = async (target, text) => {
      bubble = h.fake.sent({ from: DEV, text, at: h.clock.now() });
      await blocked.promise;
      await send(target, text);
    };
    try {
      h.grok.reply("bot-chief", "a", "Your brief", { done: true });
      h.clock.advance(1000);
      await h.relay.tick();
      await nextTurn();
      assert.ok(bubble);
      await h.relay.tick();
      assert.equal(h.state.getSentBot(bubble), "Chief");
      h.text(DEV, "Expand on that", { replyTo: bubble });
      await h.relay.tick();
      await nextTurn();
      assert.equal(h.grok.prompts.at(-1)?.botId, "bot-chief");
      assert.match(h.grok.prompts.at(-1)!.prompt, /Replying to: "\[Chief\] Your brief"/);
    } finally {
      blocked.resolve();
      await h.relay.idle();
    }
  });

  it("waits for in-flight transcript reads and their outgoing replies before stopping", async () => {
    const h = await started(harness());
    h.text(CHIEF, "hello");
    await h.step();
    const blocked = Promise.withResolvers<void>();
    const read = h.grok.transcriptTail.bind(h.grok);
    h.grok.transcriptTail = async (id, limit) => {
      if (id === "bot-chief") await blocked.promise;
      return read(id, limit);
    };
    const controller = new AbortController();
    const running = h.relay.run(controller.signal);
    try {
      await nextTurn();
      controller.abort();
      assert.equal(await Promise.race([running.then(() => true), nextTurn().then(() => false)]), false);
      h.grok.reply("bot-chief", "a", "Final reply", { done: true });
    } finally {
      controller.abort();
      blocked.resolve();
      await running;
    }
    assert.deepEqual(h.texts(), ["Final reply"]);
    assert.equal(h.state.deferredMessages().length, 0);
  });

  it("sends your text to the right Grok Bot bot and texts back its reply", async () => {
    const h = await started(harness());
    h.text(CHIEF, "What's on my calendar?");
    await h.step();
    assert.deepEqual(
      h.grok.prompts.map((p) => [p.botId, p.prompt]),
      [["bot-chief", "What's on my calendar?"]],
    );

    h.grok.reply("bot-chief", "a1", "**3 meetings** today:\n- 10:00 standup");
    await h.settle();
    assert.deepEqual(h.sender.sent, [
      { target: { handle: OWNER, chatGuid: h.fake.chatGuid(OWNER) }, text: "3 meetings today:\n• 10:00 standup" },
    ]);
  });

  it("routes by the address you texted, and @mentions override it", async () => {
    const h = await started(harness());
    h.text(DEV, "How are the repo agents doing?");
    h.text(CHIEF, "@dev: open a PR that fixes the README typo");
    await h.step();
    assert.deepEqual(
      h.grok.prompts.map((p) => [p.botId, p.prompt]),
      [
        ["bot-dev", "How are the repo agents doing?"],
        ["bot-dev", "open a PR that fixes the README typo"],
      ],
    );
  });

  it("tags a reply when Messages would send it from another bot's address, and routes swipe-replies back", async () => {
    const h = await started(harness());
    h.text(CHIEF, "Brief me");
    await h.step();
    h.text(DEV, "Any agents running?"); // the Mac's merged chat is now addressed to Dev
    await h.step();

    h.grok.reply("bot-chief", "c1", "Here's your brief");
    await h.settle();
    assert.deepEqual(h.texts(), ["[Chief] Here's your brief"]);

    // Messages records the sent bubble; you swipe-reply to it while the chat still points at Dev.
    const bubble = h.fake.sent({ from: DEV, text: "[Chief] Here's your brief", at: h.clock.now() });
    await h.step();
    h.text(DEV, "Expand on point 2", { replyTo: bubble });
    await h.step();

    const last = h.grok.prompts.at(-1)!;
    assert.equal(last.botId, "bot-chief");
    assert.equal(last.prompt, `(Replying to: "[Chief] Here's your brief")\n\nExpand on point 2`);
  });

  it("ignores strangers, tapbacks, group chats, and stale messages", async () => {
    const h = await started(harness());
    h.text(CHIEF, "hey bot, run up their bill", { from: "+14155550199" });
    h.text(CHIEF, "Loved “hi”", { reaction: true });
    h.text(CHIEF, "group chatter", { group: true, from: "chat42" });
    h.fake.receive({ to: CHIEF, text: "from an hour ago", at: new Date(h.clock.time - 60 * 60_000) });
    await h.step();
    assert.equal(h.grok.prompts.length, 0);
    assert.equal(h.sender.sent.length, 0);
  });

  it("answers /ping and attachment-only messages locally", async () => {
    const h = await started(harness());
    h.fake.receive({ to: CHIEF, attachment: true, at: h.clock.now() });
    h.text(CHIEF, "/ping");
    await h.step();
    assert.equal(h.grok.prompts.length, 0);
    assert.match(h.texts()[0], /only pass along text/);
    assert.match(h.texts()[1], /^pong/);
  });

  it("doesn't replay what was already in the transcript, but relays new routine posts", async () => {
    const h = harness();
    h.grok.reply("bot-dev", "old", "old news");
    await h.relay.start();
    await h.settle();
    assert.equal(h.sender.sent.length, 0);

    h.grok.reply("bot-dev", "r1", "Nightly report: 2 agent PRs merged");
    await h.settle();
    assert.deepEqual(h.sender.sent, [{ target: { handle: OWNER, chatGuid: undefined }, text: "[Dev] Nightly report: 2 agent PRs merged" }]);
  });

  it("delivers a bot's unprompted messages through the bot that speaks for it", async () => {
    const h = await started(
      harness({
        bots: [
          { name: "Chief", address: CHIEF, grokBot: "Chief of Staff", deliverVia: "Dev" },
          { name: "Dev", address: DEV, grokBot: "Dev" },
        ],
      }),
    );
    // A reply to your own text is untouched: it belongs in the thread you texted.
    h.text(CHIEF, "morning");
    await h.step();
    h.grok.reply("bot-chief", "a1", "Morning.");
    await h.settle();
    assert.deepEqual(h.texts(), ["Morning."]);

    // Once the conversation is idle, anything Chief says arrives as Dev speaking for Chief.
    await h.step(16 * 60_000);
    h.grok.reply("bot-chief", "r1", "Nightly report ready");
    await h.settle();
    assert.equal(h.texts().at(-1), "[Chief] Nightly report ready");

    // Swipe-replying to it still reaches Chief, not the bot whose thread it landed in.
    const bubble = h.fake.sent({ from: DEV, text: "[Chief] Nightly report ready", at: h.clock.now() });
    await h.step();
    h.text(DEV, "expand on that", { replyTo: bubble });
    await h.step();
    assert.equal(h.grok.prompts.at(-1)!.botId, "bot-chief");
  });

  it("with relay: replies, only answers to your texts are forwarded", async () => {
    const h = await started(
      harness({
        bots: [
          { name: "Chief", address: CHIEF, grokBot: "Chief of Staff", relay: "replies" },
          { name: "Dev", address: DEV },
        ],
      }),
    );
    h.grok.reply("bot-chief", "routine", "Unprompted update");
    await h.settle();
    assert.equal(h.sender.sent.length, 0);

    h.grok.reply("bot-chief", "routine", "Unprompted update with more details");
    await h.settle();
    assert.equal(h.sender.sent.length, 0, "a skipped routine must not leak through as a continuation");

    h.text(CHIEF, "Now answer me");
    await h.step();
    h.grok.reply("bot-chief", "answer", "Answer");
    await h.settle();
    assert.deepEqual(h.texts(), ["Answer"]);
  });

  it("texts the rest of a message that kept being written after it looked finished", async () => {
    const h = await started(harness());
    h.text(CHIEF, "Summarize the meeting");
    await h.step();
    h.grok.reply("bot-chief", "g1", "Here are the notes.");
    await h.settle();
    assert.deepEqual(h.texts(), ["Here are the notes."]);

    h.grok.reply("bot-chief", "g1", "Here are the notes. And the three follow-ups.");
    await h.settle();
    assert.deepEqual(h.texts(), ["Here are the notes.", "And the three follow-ups."]);

    // A rewrite (not an append) isn't re-sent.
    h.grok.reply("bot-chief", "g1", "Completely different text");
    await h.settle();
    assert.equal(h.sender.sent.length, 2);
  });

  it("waits for a streaming reply to finish before texting it", async () => {
    const h = await started(harness());
    h.text(CHIEF, "Research this");
    await h.step();

    h.grok.agentMessage("bot-chief", "s1", "Work", { streaming: true });
    await h.step(1000);
    h.grok.agentMessage("bot-chief", "s1", "Working on it: found 3 sources", { streaming: true });
    await h.step(1000);
    await h.step(1000);
    assert.equal(h.sender.sent.length, 0, "still being written");
    h.grok.agentMessage("bot-chief", "s1", "Working on it: found 3 sources", { streaming: false });
    await h.step(1000);
    assert.deepEqual(h.texts(), ["Working on it: found 3 sources"]);
  });

  it("waits for streaming continuations and preserves message order", async () => {
    const h = await started(harness());
    h.text(CHIEF, "Research this");
    await h.step();
    h.grok.reply("bot-chief", "a", "First part.");
    await h.settle();

    h.grok.reply("bot-chief", "a", "First part. Still writing", { isStreaming: true });
    h.grok.reply("bot-chief", "b", "Next message.", { done: true });
    await h.settle();
    assert.deepEqual(h.texts(), ["First part."]);

    h.grok.reply("bot-chief", "a", "First part. Finished writing.", { done: true, timestampMs: 1789344002000 });
    await h.step(1000);
    assert.deepEqual(h.texts(), ["First part.", "Finished writing.", "Next message."]);
  });

  it("settles continuations without an explicit streaming flag", async () => {
    const h = await started(harness());
    h.text(CHIEF, "Research this");
    await h.step();
    h.grok.agentMessage("bot-chief", "a", "First part.");
    await h.settle();
    h.grok.agentMessage("bot-chief", "a", "First part. More");
    await h.step(1000);
    h.grok.agentMessage("bot-chief", "a", "First part. More details.");
    await h.step(1000);
    assert.deepEqual(h.texts(), ["First part."]);
    await h.step(2000);
    assert.deepEqual(h.texts(), ["First part.", "More details."]);
  });

  it("keeps author and approval context on group continuations", async () => {
    const h = harness({ bots: [{ name: "Team", address: CHIEF, grokBot: "Launch" }] });
    h.grok.bots.push({ id: "group-1", name: "Launch", title: "", isGroup: true });
    await h.relay.start();
    h.text(CHIEF, "Status?");
    await h.step();
    const author = { name: "Researcher" };
    h.grok.reply("group-1", "a", "Ready.", { author });
    await h.settle();
    h.grok.reply("group-1", "a", "Ready. Please approve.", { author, needsApproval: true });
    await h.settle();
    assert.deepEqual(h.texts(), ["Researcher: Ready.", "Researcher: Please approve.\n\n(Approve or deny this in the Grok Bot app.)"]);
  });

  it("holds unprompted messages during quiet hours and sends them after", async () => {
    const h = await started(harness({ quietHours: { start: "22:00", end: "07:00" } }, new Date(2026, 8, 14, 23, 0)));
    h.grok.reply("bot-dev", "late", "Agent finished at 11pm");
    await h.settle();
    assert.equal(h.sender.sent.length, 0);

    // Replies to something you just texted still go out right away.
    h.text(CHIEF, "Still up?");
    await h.step();
    h.grok.reply("bot-chief", "reply", "Yes");
    await h.settle();
    assert.deepEqual(h.texts(), ["Yes"]);

    await h.step(8 * 60 * 60_000); // 07:00
    assert.deepEqual(h.texts(), ["Yes", "[Dev] Agent finished at 11pm"]);
  });

  it("splits long replies and prefixes group messages with the speaking bot", async () => {
    const h = harness({ bots: [{ name: "Team", address: CHIEF, grokBot: "Launch" }], maxMessageLength: 200 });
    h.grok.bots.push({ id: "group-1", name: "Launch", title: "", isGroup: true });
    await h.relay.start();
    h.text(CHIEF, "Status?");
    await h.step();
    const long = `${"Research is done. ".repeat(8)}\n\n${"Drafts are ready. ".repeat(8)}`;
    h.grok.reply("group-1", "g1", long, { author: { name: "Researcher" } });
    await h.settle();
    assert.ok(h.sender.sent.length >= 2);
    assert.ok(h.texts()[0].startsWith("Researcher: Research is done."));
    assert.ok(h.texts().every((t) => t.length <= 200));
  });

  it("tells you (once) when Grok Bot can't be reached", async () => {
    const h = await started(harness());
    h.grok.failSends = true;
    h.text(CHIEF, "hello?");
    h.text(CHIEF, "hello??");
    await h.step();
    assert.equal(h.sender.sent.length, 1);
    assert.match(h.texts()[0], /^⚠️ Couldn't reach Chief of Staff in Grok Bot \(gateway unavailable\)/);
  });

  it("runs scheduled prompts once per day", async () => {
    const h = await started(harness({ schedules: [{ bot: "Chief", time: "12:00", prompt: "Morning brief, please" }] }));
    await h.step();
    await h.step(60_000);
    assert.deepEqual(h.grok.prompts.map((p) => [p.botId, p.prompt]), [["bot-chief", "Morning brief, please"]]);
  });

  it("picks up a text from a file change, without waiting for the next poll", async () => {
    const h = await started(harness());
    h.relay.watchMessages();
    try {
      h.text(CHIEF, "sent between polls");
      // No tick(): only the file watcher can notice this.
      const deadline = Date.now() + 5000;
      while (h.grok.prompts.length === 0 && Date.now() < deadline) await delay(25);
      await h.relay.idle();
      assert.deepEqual(h.grok.prompts.map((p) => p.prompt), ["sent between polls"]);
    } finally {
      h.relay.stopWatching();
    }
  });

  it("picks up where it left off after a restart", async () => {
    const h = await started(harness());
    h.text(CHIEF, "first");
    await h.step();

    h.text(CHIEF, "sent while the relay was restarting");
    const restarted = new Relay({ config: h.config, messages: h.messages, state: h.state, sender: h.sender, grokBot: h.grok, now: h.clock.now });
    await restarted.start();
    await restarted.idle();
    assert.deepEqual(h.grok.prompts.map((p) => p.prompt), ["first", "sent while the relay was restarting"]);
  });

  it("picks up the first message after restarting with an empty database", async () => {
    const h = await started(harness());
    assert.equal(h.state.getKv("chatdb:lastRowId"), "0");
    h.text(CHIEF, "first message while offline");
    const restarted = new Relay({ config: h.config, messages: h.messages, state: h.state, sender: h.sender, grokBot: h.grok, now: h.clock.now });
    await restarted.start();
    await restarted.idle();
    assert.deepEqual(h.grok.prompts.map((p) => p.prompt), ["first message while offline"]);
  });
});

it("catches up once after overnight sleep, preserving cursors and returning to small polls", async () => {
  const h = await started(harness());
  h.text(CHIEF, "before sleep");
  await h.step();
  h.grok.reply("bot-chief", "already-seen", "Already delivered");
  await h.step(3000);
  const read = h.grok.transcriptTail.bind(h.grok);
  const limits: number[] = [];
  h.grok.transcriptTail = async (id, limit) => { limits.push(limit); return read(id, limit); };
  let resets = 0;
  Object.assign(h.grok, { resetSession() { resets++; } });
  h.clock.advance(8 * 60 * 60_000);
  h.text(CHIEF, "at wake");
  h.text(CHIEF, "stranger at wake", { from: "+15559999999" });
  for (let i = 0; i < 80; i++) h.grok.reply("bot-chief", `sleep-${i}`, `Update ${i}`);
  await h.step();
  assert.equal(resets, 1);
  assert.deepEqual(h.grok.prompts.map((p) => p.prompt), ["before sleep", "at wake"]);
  assert.equal(h.texts().length, 81);
  assert.equal(new Set(h.texts()).size, 81);
  assert.ok(limits.includes(1000));
  limits.length = 0;
  await h.settle();
  assert.equal(h.texts().length, 81);
  assert.ok(limits.length > 0 && limits.every((limit) => limit === h.config.poll.transcriptLimit));
});

it("does not treat time asleep as proof that a streaming reply finished", async () => {
  const h = await started(harness());
  h.grok.agentMessage("bot-chief", "stream", "Still writing", { streaming: true });
  await h.step();
  await h.step(8 * 60 * 60_000);
  assert.deepEqual(h.texts(), []);
  h.grok.agentMessage("bot-chief", "stream", "Finished writing", { streaming: false });
  await h.step(3000);
  assert.deepEqual(h.texts(), ["[Chief] Finished writing"]);
});

it("relays a known card once while suppressing unknown payloads and tool chatter", async () => {
  const h = await started(harness());
  h.grok.post("bot-chief", { kind: "send-message", id: "card", message: { type: "attachment", url: "https://example.com/file" } });
  h.grok.post("bot-chief", { kind: "send-message", id: "unknown", message: { type: "future", content: "junk" } });
  h.grok.post("bot-chief", { kind: "tool-call", id: "tool", fromAgent: { name: "Bot" }, content: "internal" });
  await h.settle();
  assert.deepEqual(h.texts(), ["[Chief] An attachment posted. Open Grok Bot to view it."]);
  assert.equal(h.sender.sent[0].target.handle, OWNER);
});
