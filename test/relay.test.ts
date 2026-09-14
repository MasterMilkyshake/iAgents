import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
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
  const config = makeConfig(configOverrides);
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

    h.grok.reply("bot-chief", "s1", "Work");
    await h.step(1000);
    h.grok.reply("bot-chief", "s1", "Working on it: found 3 sources");
    await h.step(1000);
    await h.step(1000);
    assert.equal(h.sender.sent.length, 0, "still being written");
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
    h.grok.reply("bot-chief", "a", "First part.");
    await h.settle();
    h.grok.reply("bot-chief", "a", "First part. More");
    await h.step(1000);
    h.grok.reply("bot-chief", "a", "First part. More details.");
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
