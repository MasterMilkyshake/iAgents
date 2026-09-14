import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { chunkText, markdownToText } from "../src/format.ts";
import { handlesMatch, maskHandle, normalizeHandle } from "../src/handles.ts";
import { decodeAttributedBody } from "../src/imessage/typedstream.ts";
import { parseJsonc } from "../src/jsonc.ts";
import { redact } from "../src/log.ts";
import { dueSchedules, isQuietTime, parseDays } from "../src/time.ts";
import { attributedBody } from "./helpers.ts";

describe("parseJsonc", () => {
  it("allows comments and trailing commas without touching strings", () => {
    const parsed = parseJsonc(`{
      // line comment
      "url": "https://example.com/a,}", /* block */
      "list": [1, 2,],
    }`);
    assert.deepEqual(parsed, { url: "https://example.com/a,}", list: [1, 2] });
  });

  it("keeps escaped quotes inside strings", () => {
    assert.deepEqual(parseJsonc(`{"a": "say \\"hi\\" // not a comment"}`), { a: 'say "hi" // not a comment' });
  });
});

describe("handles", () => {
  it("normalizes spellings", () => {
    assert.equal(normalizeHandle("e:Bot@iCloud.com"), "bot@icloud.com");
    assert.equal(normalizeHandle("+1 (555) 123-0000"), "+15551230000");
  });

  it("keeps plus-addressed emails intact", () => {
    // Bot addresses are Gmail plus-addresses; the + must survive normalization.
    assert.equal(normalizeHandle("e:Abhishekpallepati+Chief@gmail.com"), "abhishekpallepati+chief@gmail.com");
    assert.ok(handlesMatch("abhishekpallepati+chief@gmail.com", "e:AbhishekPallepati+Chief@gmail.com"));
    assert.ok(!handlesMatch("abhishekpallepati+chief@gmail.com", "abhishekpallepati+secretary@gmail.com"));
    assert.ok(!handlesMatch("abhishekpallepati+chief@gmail.com", "abhishekpallepati@gmail.com"));
  });

  it("matches numbers with and without country code", () => {
    assert.ok(handlesMatch("+15551230000", "(555) 123-0000"));
    assert.ok(handlesMatch("mailto:me@example.com", "ME@example.com"));
    assert.ok(!handlesMatch("+15551230000", "+15551230001"));
    assert.ok(!handlesMatch("", "+15551230000"));
  });

  it("masks handles for logs", () => {
    assert.equal(maskHandle("+15551230000"), "+1555***00");
    assert.equal(maskHandle("jonathan@gmail.com"), "jo***@gmail.com");
  });
});

describe("decodeAttributedBody", () => {
  it("reads short and long bodies", () => {
    assert.equal(decodeAttributedBody(attributedBody("hello there")), "hello there");
    const long = "x".repeat(300) + " 🚀 done";
    assert.equal(decodeAttributedBody(attributedBody(long)), long);
  });

  it("returns undefined for junk", () => {
    assert.equal(decodeAttributedBody(Buffer.from("nothing useful")), undefined);
    assert.equal(decodeAttributedBody(null), undefined);
  });
});

describe("markdownToText", () => {
  it("cleans up common markdown", () => {
    const md = "## Morning brief\n\n**Top story:** markets *up*.\n\n- one\n* two\n\nSee [the post](https://x.com/p/1) and `code`.\n\n---\n> quoted";
    assert.equal(markdownToText(md), "Morning brief\n\nTop story: markets up.\n\n• one\n• two\n\nSee the post (https://x.com/p/1) and code.\n\nquoted");
  });

  it("leaves snake_case and math alone", () => {
    assert.equal(markdownToText("set max_retries to 2 * 3"), "set max_retries to 2 * 3");
  });

  it("unwraps fenced code", () => {
    assert.equal(markdownToText("```ts\nconst a = 1;\n```"), "const a = 1;");
  });
});

describe("chunkText", () => {
  it("keeps short text whole", () => {
    assert.deepEqual(chunkText("hi", 10), ["hi"]);
  });

  it("splits on paragraphs, then words, within the limit", () => {
    const text = `${"a".repeat(60)}\n\n${"b ".repeat(80)}`;
    const chunks = chunkText(text, 100);
    assert.ok(chunks.length >= 2);
    assert.ok(chunks.every((c) => c.length <= 100));
    assert.equal(chunks.join(" ").replace(/\s+/g, ""), text.replace(/\s+/g, ""));
  });
});

describe("time", () => {
  it("parses day specs", () => {
    assert.deepEqual(parseDays("weekdays"), [1, 2, 3, 4, 5]);
    assert.deepEqual(parseDays(["Friday", "mon"]), [1, 5]);
    assert.equal(parseDays(["someday"]), undefined);
  });

  it("handles quiet hours across midnight", () => {
    const quiet = { start: "22:00", end: "07:00" };
    assert.ok(isQuietTime(quiet, new Date(2026, 8, 14, 23, 30)));
    assert.ok(isQuietTime(quiet, new Date(2026, 8, 14, 6, 59)));
    assert.ok(!isQuietTime(quiet, new Date(2026, 8, 14, 7, 0)));
    assert.ok(!isQuietTime(undefined, new Date()));
  });

  it("fires schedules once per day, within the grace window, on matching days", () => {
    const schedule = { name: "brief", bot: "Chief", time: "07:30", days: [1], prompt: "brief me" };
    const monday = (h: number, m: number) => new Date(2026, 8, 14, h, m); // 2026-09-14 is a Monday
    const never = () => false;
    assert.equal(dueSchedules([schedule], monday(7, 29), never).length, 0);
    assert.equal(dueSchedules([schedule], monday(7, 30), never).length, 1);
    assert.equal(dueSchedules([schedule], monday(9, 29), never).length, 1);
    assert.equal(dueSchedules([schedule], monday(9, 31), never).length, 0);
    assert.equal(dueSchedules([schedule], monday(8, 0), () => true).length, 0);
    assert.equal(dueSchedules([schedule], new Date(2026, 8, 15, 7, 30), never).length, 0);
  });
});

describe("redact", () => {
  it("hides bearer tokens", () => {
    assert.equal(redact("failed: Bearer abc.def-123"), "failed: Bearer <redacted>");
  });
});
