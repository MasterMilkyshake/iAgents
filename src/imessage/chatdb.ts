import { homedir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { handlesMatch } from "../handles.ts";
import { decodeAttributedBody } from "./typedstream.ts";

export const DEFAULT_CHAT_DB = join(homedir(), "Library/Messages/chat.db");

const APPLE_EPOCH_MS = Date.UTC(2001, 0, 1);
const STYLE_GROUP = 43;

export type MessageRow = {
  rowId: number;
  guid: string;
  text: string;
  isFromMe: boolean;
  sentAt: Date;
  /** The other party: who sent it (incoming) or who it went to (outgoing). */
  handle: string;
  /** The local address the message was sent to (incoming) or from (outgoing). */
  destination: string;
  chatGuid: string;
  isGroup: boolean;
  lastAddressedHandle: string;
  hasAttachments: boolean;
  /** Set when this is an inline (swipe) reply: the guid of the message being replied to. */
  threadOriginatorGuid: string;
  /** Tapbacks, stickers and other messages attached to another message. */
  isReaction: boolean;
  /** Group renames, participant changes and similar non-text items. */
  isSystem: boolean;
};

export type ChatInfo = { guid: string; identifier: string; lastAddressedHandle: string };

/** The read-only view of Messages that the rest of iAgents needs. */
export interface MessageStore {
  maxRowId(): number;
  rowsAfter(rowId: number, limit?: number): MessageRow[];
  messageText(guid: string): string | undefined;
  oneToOneChats(handle: string): ChatInfo[];
  close(): void;
}

/**
 * `message.date` is nanoseconds since 2001 on modern macOS (seconds on old versions). Those
 * nanosecond values exceed Number.MAX_SAFE_INTEGER, which node:sqlite refuses to read, so the
 * query converts to milliseconds before the value reaches JavaScript.
 */
const DATE_MS_SQL = "CASE WHEN m.date > 100000000000000 THEN m.date / 1000000 ELSE m.date * 1000 END";

export class ChatDb implements MessageStore {
  readonly path: string;
  #db: DatabaseSync | undefined;
  #columns = new Map<string, Set<string>>();

  constructor(path = DEFAULT_CHAT_DB) {
    this.path = path;
  }

  #open(): DatabaseSync {
    if (this.#db) return this.#db;
    const db = new DatabaseSync(this.path, { readOnly: true });
    db.exec("PRAGMA busy_timeout = 3000");
    for (const table of ["message", "chat"]) {
      const cols = db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[];
      this.#columns.set(table, new Set(cols.map((c) => c.name)));
    }
    this.#db = db;
    return db;
  }

  close(): void {
    this.#db?.close();
    this.#db = undefined;
  }

  /** Column reference, or NULL when this macOS version's schema lacks it. */
  #col(table: "message" | "chat", alias: string, name: string): string {
    return this.#columns.get(table)?.has(name) ? `${alias}.${name}` : "NULL";
  }

  maxRowId(): number {
    const row = this.#open().prepare("SELECT COALESCE(MAX(ROWID), 0) AS id FROM message").get() as { id: number };
    return Number(row.id);
  }

  rowsAfter(rowId: number, limit = 200): MessageRow[] {
    const db = this.#open();
    const m = (name: string) => this.#col("message", "m", name);
    const c = (name: string) => this.#col("chat", "c", name);
    const rows = db
      .prepare(
        `SELECT m.ROWID AS rowId, m.guid AS guid, m.text AS text, ${m("attributedBody")} AS body,
                m.is_from_me AS isFromMe, ${DATE_MS_SQL} AS dateMs, h.id AS handle,
                ${m("destination_caller_id")} AS destination,
                ${m("associated_message_type")} AS assocType, ${m("item_type")} AS itemType,
                ${m("cache_has_attachments")} AS hasAttachments,
                ${m("thread_originator_guid")} AS threadOriginator,
                c.guid AS chatGuid, c.chat_identifier AS chatIdentifier, ${c("style")} AS style,
                ${c("last_addressed_handle")} AS lastAddressed
         FROM message m
         LEFT JOIN handle h ON h.ROWID = m.handle_id
         LEFT JOIN chat_message_join cmj ON cmj.message_id = m.ROWID
         LEFT JOIN chat c ON c.ROWID = cmj.chat_id
         WHERE m.ROWID > ?
         ORDER BY m.ROWID ASC
         LIMIT ?`,
      )
      .all(rowId, limit) as Record<string, unknown>[];

    const seen = new Set<number>();
    const out: MessageRow[] = [];
    for (const r of rows) {
      const id = Number(r.rowId);
      if (seen.has(id)) continue; // a message joined to two chats
      seen.add(id);
      out.push({
        rowId: id,
        guid: String(r.guid ?? ""),
        text: messageBody(r.text, r.body),
        isFromMe: Number(r.isFromMe) === 1,
        sentAt: new Date(APPLE_EPOCH_MS + Number(r.dateMs ?? 0)),
        handle: String(r.handle ?? r.chatIdentifier ?? ""),
        destination: String(r.destination ?? ""),
        chatGuid: String(r.chatGuid ?? ""),
        isGroup: Number(r.style) === STYLE_GROUP,
        lastAddressedHandle: String(r.lastAddressed ?? ""),
        hasAttachments: Number(r.hasAttachments) === 1,
        threadOriginatorGuid: String(r.threadOriginator ?? ""),
        isReaction: Number(r.assocType ?? 0) !== 0,
        isSystem: Number(r.itemType ?? 0) !== 0,
      });
    }
    return out;
  }

  messageText(guid: string): string | undefined {
    const row = this.#open()
      .prepare(`SELECT text, ${this.#col("message", "message", "attributedBody")} AS body FROM message WHERE guid = ?`)
      .get(guid) as { text: unknown; body: unknown } | undefined;
    return row ? messageBody(row.text, row.body) || undefined : undefined;
  }

  oneToOneChats(handle: string): ChatInfo[] {
    const c = (name: string) => this.#col("chat", "chat", name);
    const rows = this.#open()
      .prepare(`SELECT guid, chat_identifier AS identifier, ${c("last_addressed_handle")} AS lastAddressed, ${c("style")} AS style FROM chat`)
      .all() as { guid: string; identifier: string; lastAddressed: string | null; style: number | null }[];
    return rows
      .filter((r) => Number(r.style) !== STYLE_GROUP && handlesMatch(r.identifier, handle))
      .map((r) => ({ guid: r.guid, identifier: r.identifier, lastAddressedHandle: r.lastAddressed ?? "" }));
  }

  /** How many messages were ever addressed to/from this local address (used by `doctor`). */
  countForAddress(address: string): number {
    const db = this.#open();
    if (!this.#columns.get("message")?.has("destination_caller_id")) return 0;
    const rows = db
      .prepare("SELECT destination_caller_id AS d, COUNT(*) AS n FROM message WHERE destination_caller_id IS NOT NULL GROUP BY destination_caller_id")
      .all() as { d: string; n: number }[];
    return rows.filter((r) => handlesMatch(r.d, address)).reduce((sum, r) => sum + Number(r.n), 0);
  }
}

function messageBody(text: unknown, body: unknown): string {
  const plain = typeof text === "string" && text.trim() ? text : decodeAttributedBody(body instanceof Uint8Array ? body : undefined) ?? "";
  // U+FFFC marks where an attachment sat inline.
  return plain.replace(/￼/g, "").trim();
}
