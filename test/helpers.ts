import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { validateConfig, type Config } from "../src/config.ts";
import type { GrokBotApi, GrokBotSummary } from "../src/grokbot/bridge.ts";
import type { SendTarget, Sender } from "../src/imessage/sender.ts";
import { setLogLevel } from "../src/log.ts";

setLogLevel("error");

export const OWNER = "+15551230000";
export const CHIEF = "chief.bot@icloud.com";
export const DEV = "dev.bot@icloud.com";

export function makeConfig(overrides: Record<string, unknown> = {}): Config {
  return validateConfig({
    owner: { handles: [OWNER, "me@example.com"] },
    bots: [
      { name: "Chief", address: CHIEF, grokBot: "Chief of Staff" },
      { name: "Dev", address: DEV, grokBot: "Dev" },
    ],
    poll: { grokBotActiveMs: 1000, grokBotIdleMs: 5000, stableMs: 2000 },
    ...overrides,
  });
}

/** Builds an attributedBody blob laid out like the ones Messages writes. */
export function attributedBody(text: string): Uint8Array {
  const payload = Buffer.from(text, "utf8");
  let length: Buffer;
  if (payload.length < 0x80) {
    length = Buffer.from([payload.length]);
  } else {
    length = Buffer.alloc(3);
    length[0] = 0x81;
    length.writeUInt16LE(payload.length, 1);
  }
  return Buffer.concat([
    Buffer.from("\x04\x0bstreamtyped\x81\xe8\x03\x84\x01@\x84\x84\x84\x12NSAttributedString\x00\x84\x84\x08NSObject\x00\x85\x92\x84\x84\x84\x08NSString\x01\x94\x84\x01+", "latin1"),
    length,
    payload,
    Buffer.from("\x86\x84\x02iI\x01\x05\x92\x84\x84\x84\x0cNSDictionary\x00", "latin1"),
  ]);
}

const APPLE_EPOCH_MS = Date.UTC(2001, 0, 1);

/** A throwaway chat.db with the tables and columns iAgents reads. */
export class FakeMessages {
  readonly dir = mkdtempSync(join(tmpdir(), "iagents-test-"));
  readonly path = join(this.dir, "chat.db");
  readonly db = new DatabaseSync(this.path);

  constructor() {
    this.db.exec(`
      CREATE TABLE handle (ROWID INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT NOT NULL, service TEXT);
      CREATE TABLE chat (ROWID INTEGER PRIMARY KEY AUTOINCREMENT, guid TEXT UNIQUE NOT NULL, style INTEGER,
        chat_identifier TEXT, last_addressed_handle TEXT, account_login TEXT);
      CREATE TABLE message (ROWID INTEGER PRIMARY KEY AUTOINCREMENT, guid TEXT UNIQUE NOT NULL, text TEXT,
        attributedBody BLOB, handle_id INTEGER DEFAULT 0, is_from_me INTEGER DEFAULT 0, date INTEGER, service TEXT,
        destination_caller_id TEXT, associated_message_type INTEGER DEFAULT 0, item_type INTEGER DEFAULT 0,
        cache_has_attachments INTEGER DEFAULT 0, thread_originator_guid TEXT);
      CREATE TABLE chat_message_join (chat_id INTEGER, message_id INTEGER, PRIMARY KEY (chat_id, message_id));
    `);
  }

  #handleId(id: string): number {
    const found = this.db.prepare("SELECT ROWID AS r FROM handle WHERE id = ?").get(id) as { r: number } | undefined;
    if (found) return found.r;
    return Number(this.db.prepare("INSERT INTO handle (id, service) VALUES (?, 'iMessage')").run(id).lastInsertRowid);
  }

  #chatId(identifier: string, lastAddressed: string, group: boolean): number {
    const guid = group ? `iMessage;+;chat${identifier}` : `any;-;${identifier}`;
    const found = this.db.prepare("SELECT ROWID AS r FROM chat WHERE guid = ?").get(guid) as { r: number } | undefined;
    if (found) {
      this.db.prepare("UPDATE chat SET last_addressed_handle = ? WHERE ROWID = ?").run(lastAddressed, found.r);
      return found.r;
    }
    return Number(
      this.db
        .prepare("INSERT INTO chat (guid, style, chat_identifier, last_addressed_handle) VALUES (?, ?, ?, ?)")
        .run(guid, group ? 43 : 45, identifier, lastAddressed).lastInsertRowid,
    );
  }

  chatGuid(identifier: string): string {
    return `any;-;${identifier}`;
  }

  #insert(fields: {
    from: string;
    local: string;
    fromMe: boolean;
    text?: string;
    at?: Date;
    encoded?: boolean;
    reaction?: boolean;
    replyTo?: string;
    attachment?: boolean;
    group?: boolean;
  }): string {
    const guid = randomUUID().toUpperCase();
    const at = fields.at ?? new Date();
    const text = fields.text ?? "";
    const rowId = this.db
      .prepare(
        `INSERT INTO message (guid, text, attributedBody, handle_id, is_from_me, date, service, destination_caller_id,
           associated_message_type, cache_has_attachments, thread_originator_guid)
         VALUES (?, ?, ?, ?, ?, ?, 'iMessage', ?, ?, ?, ?)`,
      )
      .run(
        guid,
        fields.encoded ? null : text,
        text ? attributedBody(text) : null,
        this.#handleId(fields.from),
        fields.fromMe ? 1 : 0,
        BigInt(at.getTime() - APPLE_EPOCH_MS) * 1_000_000n,
        fields.local,
        fields.reaction ? 2000 : 0,
        fields.attachment ? 1 : 0,
        fields.replyTo ?? null,
      ).lastInsertRowid;
    const chat = this.#chatId(fields.from, fields.local, fields.group ?? false);
    this.db.prepare("INSERT INTO chat_message_join (chat_id, message_id) VALUES (?, ?)").run(chat, rowId);
    return guid;
  }

  /** You texting a bot address from your phone. */
  receive(o: { from?: string; to: string; text?: string; at?: Date; encoded?: boolean; reaction?: boolean; replyTo?: string; attachment?: boolean; group?: boolean }): string {
    return this.#insert({ ...o, from: o.from ?? OWNER, local: o.to, fromMe: false });
  }

  /** The row Messages writes after the Mac sends a message. */
  sent(o: { to?: string; from: string; text: string; at?: Date }): string {
    return this.#insert({ from: o.to ?? OWNER, local: o.from, text: o.text, at: o.at, fromMe: true });
  }

  close(): void {
    this.db.close();
    rmSync(this.dir, { recursive: true, force: true });
  }
}

export class FakeGrokBot implements GrokBotApi {
  bots: GrokBotSummary[] = [
    { id: "bot-chief", name: "Chief of Staff", title: "", isGroup: false },
    { id: "bot-dev", name: "Dev", title: "", isGroup: false },
  ];
  prompts: { botId: string; prompt: string; nonce: string }[] = [];
  failSends = false;
  #transcripts = new Map<string, Record<string, unknown>[]>();
  #counter = 0;

  async listBots() {
    return this.bots;
  }

  async sendPrompt(botId: string, prompt: string, nonce: string) {
    if (this.failSends) throw new Error("gateway unavailable");
    this.prompts.push({ botId, prompt, nonce });
    this.post(botId, { id: `user-${++this.#counter}`, role: "user", text: prompt });
  }

  async transcriptTail(botId: string, limit: number) {
    return { entries: (this.#transcripts.get(botId) ?? []).slice(-limit) };
  }

  post(botId: string, entry: Record<string, unknown>): void {
    const list = this.#transcripts.get(botId) ?? [];
    const existing = list.findIndex((e) => e.id !== undefined && e.id === entry.id);
    if (existing >= 0) list[existing] = entry;
    else list.push(entry);
    this.#transcripts.set(botId, list);
  }
}

export class RecordingSender implements Sender {
  sent: { target: SendTarget; text: string }[] = [];

  async send(target: SendTarget, text: string) {
    this.sent.push({ target, text });
  }
}

export class Clock {
  time: number;
  constructor(start = new Date(2026, 8, 14, 12, 0, 0)) {
    this.time = start.getTime();
  }
  now = () => new Date(this.time);
  advance(ms: number) {
    this.time += ms;
  }
}
