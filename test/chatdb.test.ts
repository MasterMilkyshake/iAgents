import assert from "node:assert/strict";
import { after, describe, it } from "node:test";
import { ChatDb } from "../src/imessage/chatdb.ts";
import { CHIEF, DEV, FakeMessages, OWNER } from "./helpers.ts";

describe("ChatDb", () => {
  const fake = new FakeMessages();
  const db = new ChatDb(fake.path);
  after(() => {
    db.close();
    fake.close();
  });

  it("reads incoming messages, including text stored only in attributedBody and real nanosecond dates", () => {
    const at = new Date("2026-09-14T15:04:05.678Z");
    const start = db.maxRowId();
    const plain = fake.receive({ to: CHIEF, text: "plain text", at });
    const encoded = fake.receive({ to: DEV, text: "only in attributedBody", encoded: true, at });
    const rows = db.rowsAfter(start);

    assert.equal(rows.length, 2);
    assert.deepEqual(
      { guid: rows[0].guid, text: rows[0].text, handle: rows[0].handle, destination: rows[0].destination, isFromMe: rows[0].isFromMe, isGroup: rows[0].isGroup },
      { guid: plain, text: "plain text", handle: OWNER, destination: CHIEF, isFromMe: false, isGroup: false },
    );
    assert.equal(rows[0].sentAt.toISOString(), at.toISOString());
    assert.equal(rows[1].guid, encoded);
    assert.equal(rows[1].text, "only in attributedBody");
    assert.equal(rows[1].lastAddressedHandle, DEV);
    assert.equal(db.maxRowId(), rows[1].rowId);
  });

  it("flags reactions, group chats, attachments, and inline replies", () => {
    const start = db.maxRowId();
    const original = fake.receive({ to: CHIEF, text: "original" });
    fake.receive({ to: CHIEF, text: "Loved “original”", reaction: true });
    fake.receive({ to: CHIEF, text: "group hello", group: true, from: "chat123" });
    fake.receive({ to: CHIEF, attachment: true });
    fake.receive({ to: CHIEF, text: "replying", replyTo: original });
    const [, reaction, group, attachment, reply] = db.rowsAfter(start);
    assert.ok(reaction.isReaction);
    assert.ok(group.isGroup);
    assert.ok(attachment.hasAttachments && attachment.text === "");
    assert.equal(reply.threadOriginatorGuid, original);
    assert.equal(db.messageText(original), "original");
  });

  it("finds one-to-one chats by handle, whatever the spelling", () => {
    const chats = db.oneToOneChats("(555) 123-0000");
    assert.equal(chats.length, 1);
    assert.equal(chats[0].guid, fake.chatGuid(OWNER));
    assert.equal(db.oneToOneChats("+19998887777").length, 0);
  });

  it("counts messages per bot address", () => {
    assert.ok(db.countForAddress(`e:${CHIEF.toUpperCase()}`) >= 1);
    assert.equal(db.countForAddress("nobody@icloud.com"), 0);
  });
});
