import { createHash } from "node:crypto";
import { presentPost } from "./posts.ts";

/**
 * Grok Bot's gateway API is undocumented. As of Grok Bot 0.47 a transcript looks like:
 *
 *   { "entries": [
 *       { "kind": "message",      "id": "t1u",  "role": "user", "content": "…",
 *         "isStreaming": false, "timestampMs": 1789344111368 },
 *       { "kind": "send-message", "id": "t1s0", "message": { "type": "text", "content": "…" },
 *         "timestampMs": 1789344114084 }
 *     ] }
 *
 * Bot messages carry no role: the kind is what marks them. Entries are read defensively so a
 * format change degrades to "don't relay" rather than relaying junk; anything not recognizable
 * as a message from the bot (tool calls, thinking, status, your own messages) is ignored.
 * Run `iagents probe <bot>` to see the current raw shape.
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
  /** Fixed diagnostic, never entry contents, for unsupported visible shapes. */
  ignoredReason?: string;
};

type Obj = Record<string, unknown>;

const USER_ROLES = new Set(["user", "human", "owner", "me", "client"]);
const BOT_ROLES = new Set(["assistant", "agent", "bot", "ai", "model"]);
/** Entry kinds that mean "the bot said this", which carry no role of their own. */
const BOT_KINDS = new Set(["send-message", "send_message", "sendmessage", "assistant-message", "agent-message", "bot-message"]);
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
  let role = classifyRole(e);
  const post = role === "user" ? undefined : presentPost(e);
  if (post?.text && ["notice", "event", "feedback"].includes(lower(e.kind))) role = "bot";
  const ask = permissionAsk(e);
  const text = (post?.text ?? ask ?? entryText(e)).trim();
  const id = str(e.id) || str(e.messageId) || str(e.entryId) || str(e.uuid) || str(e.key) || syntheticId(e, role, text);
  const kind = `${lower(e.type)} ${lower(e.kind)}`;
  const at = timestamp(e.timestampMs ?? e.timestamp_ms ?? e.createdAt ?? e.created_at ?? e.timestamp ?? e.time ?? e.sentAt);
  return {
    id,
    role,
    text,
    complete: completion(e) === false ? false : post?.text ? true : completion(e),
    author:
      str(asObj(e.fromAgent)?.name) ||
      str(asObj(e.author)?.name) ||
      str(asObj(e.sender)?.name) ||
      str(e.agentName) ||
      str(e.authorName),
    needsApproval: post?.needsApproval === true || ask !== undefined || /approv|permission/.test(kind) || e.requiresApproval === true || e.needsApproval === true,
    ...(at === undefined ? {} : { at }),
    ...(post?.ignoredReason ? { ignoredReason: post.ignoredReason } : {}),
  };
}

/**
 * A bot waiting on approval posts a send-message whose payload is a permission ask rather than
 * text (`message.type: "local-tool-permission"`). It has no text of its own, so describe it —
 * otherwise a blocked bot looks like silence.
 */
function permissionAsk(e: Obj): string | undefined {
  const message = asObj(e.message);
  if (!message || message.type !== "local-tool-permission") return undefined;
  const ask = asObj(message.ask) ?? {};
  const status = lower(ask.status) || lower(message.status);
  if (status && status !== "pending") return undefined; // already answered or expired
  const action = str(message.action) || str(ask.action);
  const target = str(message.target) || str(ask.target);
  const what = [action.replace(/[-_]/g, " "), target].filter(Boolean).join(": ");
  return `Waiting for your approval${what ? ` to ${what}` : ""}.`;
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
  if (/tool|function|thinking|reasoning|status|progress|system|log|trace|debug|typing/.test(kind)) return "other";
  if (BOT_KINDS.has(lower(e.kind)) || BOT_KINDS.has(lower(e.type))) return "bot";
  // A "message" entry from a bot carries fromAgent; the same shape with role "user" is yours.
  if (lower(e.kind) === "message" && asObj(e.fromAgent) !== undefined) return "bot";
  if (NON_MESSAGE_TYPE.test(kind) && !MESSAGE_TYPE.test(kind)) return "other";
  if (BOT_ROLES.has(role)) return "bot";
  // Some transcripts only encode the speaker in the type, e.g. "user_message" / "assistant_message".
  if (/user|human/.test(kind)) return "user";
  if (/assistant|agent|bot/.test(kind)) return "bot";
  return "other";
}

function entryText(e: Obj): string {
  for (const key of ["text", "message", "body", "markdown", "content", "preview"]) {
    const value = valueText(e[key]);
    if (value.trim()) return value;
  }
  return "";
}

/** Text out of a string, a list of parts, or a wrapper like { type: "text", content: "…" }. */
function valueText(value: unknown): string {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) return value.map(partText).filter(Boolean).join("\n");
  const obj = asObj(value);
  if (!obj) return "";
  const type = lower(obj.type);
  if (type && !/text|markdown|output/.test(type)) return ""; // image, file, card, tool call, …
  if (typeof obj.text === "string" && obj.text.trim()) return obj.text;
  if (typeof obj.content === "string") return obj.content;
  if (Array.isArray(obj.content)) return obj.content.map(partText).filter(Boolean).join("\n");
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
  // Grok Bot sets isStreaming explicitly; false means the write finished.
  if (e.isStreaming === false || e.streaming === false) return true;
  // Grok Bot streams only "message" entries (its own check is `kind === "message" && isStreaming`).
  // A send-message is written in one go, so relay it immediately instead of waiting for it to settle.
  if (BOT_KINDS.has(lower(e.kind)) || BOT_KINDS.has(lower(e.type))) return true;
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
  #pending = new Map<string, { text: string; changedAt: number; firstSeen: number; streaming: boolean }>();

  constructor(stableMs: number, maxWaitMs = 5 * 60_000) {
    this.stableMs = stableMs;
    this.maxWaitMs = maxWaitMs;
  }

  ready(entries: TranscriptEntry[], now: number, isSeen: (id: string) => boolean): TranscriptEntry[] {
    const out: TranscriptEntry[] = [];
    // Entries can fall out of the transcript tail or become ineligible between polls.
    // Forget them so stale state doesn't keep an idle bot on the fast polling interval.
    const eligible = new Set(entries.filter((entry) => entry.role === "bot" && entry.text && !isSeen(entry.id)).map((entry) => entry.id));
    for (const id of this.#pending.keys()) {
      if (!eligible.has(id)) this.#pending.delete(id);
    }
    for (let i = 0; i < entries.length; i++) {
      const entry = entries[i];
      if (!eligible.has(entry.id)) continue;

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
        this.#pending.set(entry.id, { text: entry.text, changedAt: changed ? now : prev.changedAt, firstSeen, streaming: entry.complete === false });
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

  resetPending(): void {
    this.#pending.clear();
  }

  /** Next settling/timeout deadline; explicit streaming flags still require normal polling. */
  nextCheckAt(): number | undefined {
    if (!this.#pending.size) return undefined;
    return Math.min(...[...this.#pending.values()].map((entry) =>
      Math.min(entry.firstSeen + this.maxWaitMs, entry.streaming ? Infinity : entry.changedAt + this.stableMs),
    ));
  }
}
