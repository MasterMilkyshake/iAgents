import { createHash } from "node:crypto";

/**
 * Grok Bot's gateway API is undocumented, so transcript entries are read defensively:
 * several plausible field names are accepted, and anything that isn't clearly a message
 * from the bot (tool calls, thinking, status updates, your own messages) is ignored.
 * Run `iagents probe <bot>` to see the raw shape if relaying ever misbehaves.
 */

export type EntryRole = "user" | "bot" | "other";

export type TranscriptEntry = {
  id: string;
  role: EntryRole;
  text: string;
  /** true/false when the entry says so; null when it doesn't (then we wait for the text to settle). */
  complete: boolean | null;
  author: string;
  needsApproval: boolean;
  /** Creation time in ms, when the entry has one. */
  at?: number;
};

type Obj = Record<string, unknown>;

const USER_ROLES = new Set(["user", "human", "owner", "me", "client"]);
const BOT_ROLES = new Set(["assistant", "agent", "bot", "ai", "model"]);
const NON_MESSAGE_TYPE = /tool|function|thinking|reasoning|status|progress|event|system|log|trace|debug|typing/;
const MESSAGE_TYPE = /message|reply|response|text|answer/;
const IN_PROGRESS = new Set(["streaming", "pending", "in_progress", "inprogress", "running", "generating", "partial", "queued", "working"]);
const DONE = new Set(["complete", "completed", "done", "finished", "final", "sent", "delivered", "succeeded", "success"]);

function asObj(value: unknown): Obj | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Obj) : undefined;
}

function str(value: unknown): string {
  return typeof value === "string" ? value : typeof value === "number" ? String(value) : "";
}

function lower(value: unknown): string {
  return str(value).trim().toLowerCase();
}

export function extractEntries(payload: unknown): unknown[] {
  const wrapper = asObj(payload);
  for (const candidate of [payload, wrapper?.transcript, wrapper?.thread, wrapper?.data]) {
    if (Array.isArray(candidate)) return candidate;
    const obj = asObj(candidate);
    if (!obj) continue;
    for (const key of ["entries", "messages", "items", "events", "transcript"]) {
      if (Array.isArray(obj[key])) return obj[key] as unknown[];
    }
  }
  return [];
}

export function parseEntry(raw: unknown): TranscriptEntry | undefined {
  const e = asObj(raw);
  if (!e) return undefined;
  const role = classifyRole(e);
  const text = entryText(e).trim();
  const id = str(e.id) || str(e.messageId) || str(e.entryId) || str(e.uuid) || str(e.key) || syntheticId(e, role, text);
  const kind = `${lower(e.type)} ${lower(e.kind)}`;
  const at = timestamp(e.createdAt ?? e.created_at ?? e.timestamp ?? e.time ?? e.sentAt);
  return {
    id,
    role,
    text,
    complete: completion(e),
    author: str(asObj(e.author)?.name) || str(asObj(e.sender)?.name) || str(e.agentName) || str(e.authorName),
    needsApproval: /approv|permission/.test(kind) || e.requiresApproval === true || e.needsApproval === true,
    ...(at === undefined ? {} : { at }),
  };
}

function timestamp(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return value < 1e12 ? value * 1000 : value;
  if (typeof value === "string" && value.trim()) {
    const parsed = /^\d+$/.test(value) ? Number(value) : Date.parse(value);
    if (Number.isFinite(parsed)) return parsed < 1e12 ? parsed * 1000 : parsed;
  }
  return undefined;
}

/** Oldest first. Only reorders when every entry has a timestamp; otherwise trusts the API's order. */
export function chronological(entries: TranscriptEntry[]): TranscriptEntry[] {
  if (entries.length < 2 || entries.some((e) => e.at === undefined)) return entries;
  return entries
    .map((entry, index) => ({ entry, index }))
    .sort((a, b) => a.entry.at! - b.entry.at! || a.index - b.index)
    .map(({ entry }) => entry);
}

function classifyRole(e: Obj): EntryRole {
  const kind = `${lower(e.type)} ${lower(e.kind)}`;
  const role =
    lower(e.role) ||
    lower(asObj(e.author)?.role) ||
    lower(asObj(e.sender)?.role) ||
    lower(e.senderType) ||
    lower(e.authorType) ||
    lower(e.from) ||
    lower(e.sender) ||
    lower(e.author);
  if (USER_ROLES.has(role)) return "user";
  if (NON_MESSAGE_TYPE.test(kind) && !MESSAGE_TYPE.test(kind)) return "other";
  if (BOT_ROLES.has(role)) return "bot";
  // Some transcripts only encode the speaker in the type, e.g. "user_message" / "assistant_message".
  if (/user|human/.test(kind)) return "user";
  if (/assistant|agent|bot/.test(kind)) return "bot";
  return "other";
}

function entryText(e: Obj): string {
  for (const key of ["text", "message", "body", "markdown", "content", "preview"]) {
    const value = e[key];
    if (typeof value === "string" && value.trim()) return value;
    if (Array.isArray(value)) {
      const joined = value.map(partText).filter(Boolean).join("\n");
      if (joined.trim()) return joined;
    }
    const nested = asObj(value);
    if (nested && typeof nested.text === "string" && nested.text.trim()) return nested.text;
  }
  return "";
}

function partText(part: unknown): string {
  if (typeof part === "string") return part;
  const p = asObj(part);
  if (!p) return "";
  const type = lower(p.type);
  if (type && !/text|markdown|output/.test(type)) return ""; // tool_use, image, file, ...
  return str(p.text) || str(p.content);
}

function completion(e: Obj): boolean | null {
  if (e.isStreaming === true || e.streaming === true || e.pending === true || e.partial === true || e.isPartial === true) return false;
  const status = lower(e.status) || lower(e.state);
  if (IN_PROGRESS.has(status)) return false;
  if (e.done === true || e.complete === true || e.isComplete === true || e.final === true || DONE.has(status)) return true;
  return null;
}

function syntheticId(e: Obj, role: EntryRole, text: string): string {
  const when = str(e.createdAt) || str(e.created_at) || str(e.timestamp) || str(e.time);
  return "h:" + createHash("sha1").update(`${role}|${when}|${text.slice(0, 64)}`).digest("hex").slice(0, 20);
}

/**
 * Decides when a bot message is finished and safe to relay. An entry is finished when it
 * says so, when anything comes after it, or when its text hasn't changed for `stableMs`.
 * Entries are released strictly in order, so a long reply still being written holds back
 * the ones after it.
 */
export class TranscriptTracker {
  readonly stableMs: number;
  readonly maxWaitMs: number;
  #pending = new Map<string, { text: string; changedAt: number; firstSeen: number }>();

  constructor(stableMs: number, maxWaitMs = 5 * 60_000) {
    this.stableMs = stableMs;
    this.maxWaitMs = maxWaitMs;
  }

  ready(entries: TranscriptEntry[], now: number, isSeen: (id: string) => boolean): TranscriptEntry[] {
    const out: TranscriptEntry[] = [];
    for (let i = 0; i < entries.length; i++) {
      const entry = entries[i];
      if (entry.role !== "bot" || !entry.text || isSeen(entry.id)) continue;

      const prev = this.#pending.get(entry.id);
      const firstSeen = prev?.firstSeen ?? now;
      const followed = i < entries.length - 1;
      const settled = prev !== undefined && prev.text === entry.text && now - prev.changedAt >= this.stableMs;
      const overdue = now - firstSeen >= this.maxWaitMs;

      const done =
        overdue ||
        entry.complete === true ||
        (entry.complete === null && (followed || settled || this.stableMs === 0));

      if (!done) {
        const changed = !prev || prev.text !== entry.text;
        this.#pending.set(entry.id, { text: entry.text, changedAt: changed ? now : prev.changedAt, firstSeen });
        break;
      }
      this.#pending.delete(entry.id);
      out.push(entry);
    }
    return out;
  }

  hasPending(): boolean {
    return this.#pending.size > 0;
  }
}
