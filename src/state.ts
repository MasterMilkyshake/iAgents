import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { handlesMatch } from "./handles.ts";

const PENDING_SENT_TTL_MS = 5 * 60_000;
const SEEN_PER_BOT = 2000;
const SENT_BOT_TTL_MS = 30 * 24 * 60 * 60_000;

function normalizeText(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

/** Everything the relay remembers between restarts, in ~/Library/Application Support/iAgents/state.db. */
export class State {
  readonly db: DatabaseSync;

  constructor(dir: string) {
    if (dir === ":memory:") {
      this.db = new DatabaseSync(":memory:");
    } else {
      mkdirSync(dir, { recursive: true });
      this.db = new DatabaseSync(join(dir, "state.db"));
      this.db.exec("PRAGMA journal_mode = WAL");
    }
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS kv (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS transcript_seen (
        bot_id TEXT NOT NULL, entry_id TEXT NOT NULL, seen_at INTEGER NOT NULL,
        PRIMARY KEY (bot_id, entry_id)
      );
      CREATE TABLE IF NOT EXISTS pending_sent (
        id INTEGER PRIMARY KEY AUTOINCREMENT, handle TEXT NOT NULL, text TEXT NOT NULL,
        bot_name TEXT NOT NULL, created_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS sent_bot (guid TEXT PRIMARY KEY, bot_name TEXT NOT NULL, created_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS deferred (id INTEGER PRIMARY KEY AUTOINCREMENT, payload TEXT NOT NULL, created_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS schedule_runs (name TEXT NOT NULL, day TEXT NOT NULL, PRIMARY KEY (name, day));
    `);
  }

  close(): void {
    this.db.close();
  }

  getKv(key: string): string | undefined {
    const row = this.db.prepare("SELECT value FROM kv WHERE key = ?").get(key) as { value: string } | undefined;
    return row?.value;
  }

  setKv(key: string, value: string): void {
    this.db.prepare("INSERT INTO kv (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(key, value);
  }

  isSeen(botId: string, entryId: string): boolean {
    return this.db.prepare("SELECT 1 FROM transcript_seen WHERE bot_id = ? AND entry_id = ?").get(botId, entryId) !== undefined;
  }

  markSeen(botId: string, entryIds: string[], now: number): void {
    const insert = this.db.prepare("INSERT OR IGNORE INTO transcript_seen (bot_id, entry_id, seen_at) VALUES (?, ?, ?)");
    for (const id of entryIds) insert.run(botId, id, now);
    this.db
      .prepare(
        `DELETE FROM transcript_seen WHERE bot_id = ? AND entry_id NOT IN (
           SELECT entry_id FROM transcript_seen WHERE bot_id = ? ORDER BY seen_at DESC LIMIT ?)`,
      )
      .run(botId, botId, SEEN_PER_BOT);
  }

  /** Remembers a message we just handed to Messages.app, until its chat.db row shows up. */
  addPendingSent(handle: string, text: string, botName: string, now: number): void {
    this.db.prepare("INSERT INTO pending_sent (handle, text, bot_name, created_at) VALUES (?, ?, ?, ?)").run(handle, normalizeText(text), botName, now);
  }

  /** Claims the oldest pending message to `handle` with this text and returns which bot sent it. */
  takePendingSent(handle: string, text: string, now: number): string | undefined {
    this.db.prepare("DELETE FROM pending_sent WHERE created_at < ?").run(now - PENDING_SENT_TTL_MS);
    const rows = this.db.prepare("SELECT id, handle, bot_name FROM pending_sent WHERE text = ? ORDER BY id").all(normalizeText(text)) as {
      id: number;
      handle: string;
      bot_name: string;
    }[];
    const row = rows.find((r) => handlesMatch(r.handle, handle));
    if (!row) return undefined;
    this.db.prepare("DELETE FROM pending_sent WHERE id = ?").run(row.id);
    return row.bot_name;
  }

  setSentBot(guid: string, botName: string, now: number): void {
    this.db.prepare("INSERT OR REPLACE INTO sent_bot (guid, bot_name, created_at) VALUES (?, ?, ?)").run(guid, botName, now);
    this.db.prepare("DELETE FROM sent_bot WHERE created_at < ?").run(now - SENT_BOT_TTL_MS);
  }

  /** The bot that sent the iMessage with this guid, if iAgents sent it. */
  getSentBot(guid: string): string | undefined {
    const row = this.db.prepare("SELECT bot_name FROM sent_bot WHERE guid = ?").get(guid) as { bot_name: string } | undefined;
    return row?.bot_name;
  }

  deferMessage(payload: unknown, now: number): void {
    this.db.prepare("INSERT INTO deferred (payload, created_at) VALUES (?, ?)").run(JSON.stringify(payload), now);
  }

  /** Removes and returns every deferred message, oldest first. */
  takeDeferred(): unknown[] {
    const rows = this.db.prepare("SELECT id, payload FROM deferred ORDER BY id").all() as { id: number; payload: string }[];
    if (rows.length > 0) this.db.prepare("DELETE FROM deferred WHERE id <= ?").run(rows[rows.length - 1].id);
    return rows.map((r) => JSON.parse(r.payload));
  }

  hasScheduleRun(name: string, day: string): boolean {
    return this.db.prepare("SELECT 1 FROM schedule_runs WHERE name = ? AND day = ?").get(name, day) !== undefined;
  }

  markScheduleRun(name: string, day: string): void {
    this.db.prepare("INSERT OR IGNORE INTO schedule_runs (name, day) VALUES (?, ?)").run(name, day);
  }
}
