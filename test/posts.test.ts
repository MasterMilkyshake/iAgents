import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { parseEntry } from "../src/grokbot/transcript.ts";

const captured = JSON.parse(readFileSync(new URL("./fixtures/grokbot-posts.json", import.meta.url), "utf8"));
describe("sanitized live transcript fixtures", () => {
  for (const [name, raw] of Object.entries(captured)) {
    it(name, () => {
      const entry = parseEntry(raw)!;
      if (/approval:|permission:/.test(name)) assert.equal(entry.text, "");
      else {
        assert.equal(entry.role, "bot");
        assert.match(entry.text, /posted\. Open Grok Bot/);
        assert.equal(entry.complete, true);
        assert.ok(!entry.text.includes("redacted"));
      }
      assert.equal(entry.ignoredReason, undefined);
    });
  }
});

// Bundle-derived fixtures, not live captures. Registry and wrapper fields: docs/transcript-shapes.md.
const cards: Record<string, Record<string, unknown>> = {
  attachment: { url: "https://example.com/file.png" },
  widget: { widget: { options: [{ label: "Yes", value: "yes" }] } },
  "cursor-agent": { bcId: "agent-id" },
  "secret-request": { secretRequest: { label: "Secret" } },
  "credential-request": { credentialRequest: { credentialId: "credential-id" } },
  "user-form": { formRequest: { title: "Form", fields: [] } },
  "email-draft": { draft: { from: "a@example.com", to: [], subject: "Subject", body: "Body" } },
  "slack-draft": { draft: { workspace: "workspace", target: "channel", body: "Body" } },
  "permission-request": { permission: { title: "Permission" } },
  connector: { connector: "github", variant: "connect" },
  connectors: { connectors: ["github"] },
  "listener-connect": { platform: "slack" },
  "scm-connect": { provider: "github", intent: "connect" },
  "team-access": {},
  "slack-connect": {},
  "bot-template-share": { shareId: "share-id", name: "Template", body: "Body" },
};
describe("bundle-verified post placeholders", () => {
  for (const [type, fields] of Object.entries(cards)) {
    it(type, () => {
      const entry = parseEntry({ kind: "send-message", message: { type, ...fields } })!;
      assert.equal(entry.role, "bot");
      assert.match(entry.text, /posted\. Open Grok Bot to view it\.$/);
      assert.equal(entry.complete, true);
      assert.equal(entry.ignoredReason, undefined);
    });
  }
  for (const type of ["auto-review-approval", "cookie-origin-approval", "virtual-card-approval"]) {
    it(`${type} pending and resolved`, () => {
      for (const status of ["pending", "approved", "expired"]) {
        const entry = parseEntry({ kind: "send-message", message: { type, approval: { requestId: "request", status } } })!;
        assert.equal(entry.needsApproval, status === "pending");
        assert.equal(Boolean(entry.text), status === "pending");
      }
    });
  }
  for (const event of [
    { type: "name-changed", from: "Before", to: "After" },
    { type: "automation-changed", action: "created", automationId: "routine", automationName: "Routine" },
    { type: "channel-connected", label: "Channel" },
    { type: "channel-disconnected", label: "Channel" },
  ]) it(`event ${event.type}`, () => {
    const entry = parseEntry({ kind: "event", event })!;
    assert.equal(entry.role, "bot");
    assert.match(entry.text, /posted/);
  });
  it("notice", () => assert.match(parseEntry({ kind: "notice", text: "Notice" })!.text, /^A notice posted/));
  it("feedback card and voted response", () => {
    assert.match(parseEntry({ kind: "feedback", state: "pending" })!.text, /^A feedback card posted/);
    assert.equal(parseEntry({ kind: "feedback", state: "voted", sentiment: "positive" })!.text, "");
  });
  it("image-only text payload", () => {
    assert.match(parseEntry({ kind: "send-message", message: { type: "text", content: "", images: [{ url: "https://example.com/image.png" }] } })!.text, /^An image posted/);
  });
  it("unknown and malformed shapes stay silent with diagnostics", () => {
    for (const raw of [
      { kind: "send-message", text: "do not relay", message: { type: "future-card", content: "do not relay" } },
      { kind: "send-message", message: { type: "attachment", url: {} } },
      { kind: "send-message", message: { type: "widget", widget: "invalid" } },
      { kind: "event", event: { type: "future-event" } },
      { kind: "notice" },
      { kind: "feedback" },
    ]) {
      const entry = parseEntry(raw)!;
      assert.equal(entry.text, "");
      assert.ok(entry.ignoredReason);
    }
  });
  it("does not promote tool chatter or owner posts to bot messages", () => {
    for (const kind of ["tool-call", "thinking", "status"]) {
      assert.equal(parseEntry({ kind, role: "assistant", fromAgent: { name: "Bot" }, message: { type: "widget", widget: {} } })!.role, "other");
    }
    assert.equal(parseEntry({ kind: "notice", role: "user", text: "Mine" })!.role, "user");
  });
  it("honors explicit streaming flags for placeholders", () => {
    assert.equal(parseEntry({ kind: "send-message", streaming: true, message: { type: "widget", widget: {} } })!.complete, false);
  });
});
