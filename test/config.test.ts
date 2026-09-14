import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { ConfigError, validateConfig } from "../src/config.ts";
import { makeConfig, OWNER } from "./helpers.ts";

const base = {
  owner: { handles: [OWNER] },
  bots: [{ name: "Chief", address: "chief@icloud.com", grokBot: "Chief of Staff" }],
};

describe("validateConfig", () => {
  it("fills in defaults", () => {
    const config = validateConfig(base);
    assert.equal(config.owner.notify, OWNER);
    assert.equal(config.bots[0].relay, "all");
    assert.equal(config.tagReplies, "auto");
    assert.equal(config.poll.stableMs, 2500);
    assert.equal(config.poll.chatDbMs, 500);
    assert.equal(config.poll.grokBotActiveMs, 2000);
    assert.equal(config.poll.grokBotIdleMs, 15_000);
    assert.match(config.chatDbPath, /Library\/Messages\/chat\.db$/);
  });

  it("uses the bot name when grokBot is omitted", () => {
    const config = validateConfig({ ...base, bots: [{ name: "Dev", address: "dev@icloud.com" }] });
    assert.equal(config.bots[0].grokBot, "Dev");
  });

  it("parses schedules", () => {
    const config = makeConfig({ schedules: [{ bot: "chief", time: "7:30", days: "weekdays", prompt: "Morning brief" }] });
    assert.deepEqual(config.schedules[0], { name: "Chief 7:30", bot: "Chief", time: "7:30", days: [1, 2, 3, 4, 5], prompt: "Morning brief" });
  });

  it("resolves deliverVia to a configured bot name", () => {
    const config = validateConfig({
      ...base,
      bots: [{ name: "Manager", address: "m@icloud.com", deliverVia: "secretary" }, { name: "Secretary", address: "s@icloud.com" }],
    });
    assert.equal(config.bots[0].deliverVia, "Secretary");
    assert.equal(config.bots[1].deliverVia, undefined);
  });

  const invalid: [string, unknown, RegExp][] = [
    ["missing owner", { bots: base.bots }, /owner is required/],
    ["no bots", { ...base, bots: [] }, /at least one bot/],
    ["duplicate names", { ...base, bots: [...base.bots, { name: "chief", address: "x@icloud.com" }] }, /Two bots/],
    ["duplicate addresses", { ...base, bots: [...base.bots, { name: "Dev", address: "CHIEF@icloud.com" }] }, /different address/],
    ["bot uses owner address", { ...base, bots: [{ name: "Chief", address: "+1 555 123 0000" }] }, /own owner.handles/],
    ["name with spaces", { ...base, bots: [{ name: "Chief of Staff", address: "c@icloud.com" }] }, /one word/],
    ["bad schedule time", { ...base, schedules: [{ bot: "Chief", time: "7am", prompt: "x" }] }, /HH:MM/],
    ["schedule for unknown bot", { ...base, schedules: [{ bot: "Nope", time: "07:00", prompt: "x" }] }, /isn't in bots/],
    ["bad quiet hours", { ...base, quietHours: { start: "late", end: "07:00" } }, /quietHours/],
    ["unknown defaultBot", { ...base, defaultBot: "Nope" }, /defaultBot/],
    ["deliverVia to nobody", { ...base, bots: [{ name: "Manager", address: "m@icloud.com", deliverVia: "Nope" }] }, /deliverVia "Nope" isn't in bots/],
    ["deliverVia to itself", { ...base, bots: [{ name: "Manager", address: "m@icloud.com", deliverVia: "manager" }] }, /can't be itself/],
    [
      "chained deliverVia",
      {
        ...base,
        bots: [
          { name: "Manager", address: "m@icloud.com", deliverVia: "Secretary" },
          { name: "Secretary", address: "s@icloud.com", deliverVia: "Aide" },
          { name: "Aide", address: "a@icloud.com" },
        ],
      },
      /also delivers via someone else/,
    ],
  ];
  for (const [name, raw, pattern] of invalid) {
    it(`rejects ${name}`, () => {
      assert.throws(() => validateConfig(raw), (err: unknown) => err instanceof ConfigError && pattern.test(err.message));
    });
  }
});

it("rejects notification recipients outside owner.handles", () => {
  assert.throws(() => validateConfig({ owner: { handles: ["me@example.com"], notify: "stranger@example.com" }, bots: [{ name: "Bot", address: "bot@example.com" }] }), /owner.notify must be in owner.handles/);
});
