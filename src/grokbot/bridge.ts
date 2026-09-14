import { createHash } from "node:crypto";
import type { BotContact, Config } from "../config.ts";
import { truncate } from "../format.ts";
import type { Outbox } from "../imessage/outbox.ts";
import { errorMessage, log } from "../log.ts";
import type { InboundMessage } from "../router.ts";
import type { State } from "../state.ts";
import { chronological, extractEntries, parseEntry, TranscriptTracker, type TranscriptEntry } from "./transcript.ts";

export type GrokBotSummary = { id: string; name: string; title: string; isGroup: boolean };

export interface GrokBotApi {
  listBots(): Promise<GrokBotSummary[]>;
  sendPrompt(botId: string, prompt: string, clientNonce: string): Promise<void>;
  transcriptTail(botId: string, limit: number): Promise<unknown>;
}

const CALL_TIMEOUT_MS = 45_000;

function withTimeout<T>(promise: Promise<T>, label: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} timed out`)), CALL_TIMEOUT_MS);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

/**
 * Talks to your Grok Bot cloud computer through the desktop app's signed-in session,
 * using grok-bot-cli's gateway client. This is the same private API the app uses;
 * it is not an official, documented interface and may change without notice.
 */
export async function createGatewayApi(): Promise<GrokBotApi> {
  const gateway = await import("grok-bot-cli/src/gateway.js");
  let session: Awaited<ReturnType<typeof gateway.connectGateway>> | undefined;

  async function call<T>(label: string, fn: (s: NonNullable<typeof session>) => Promise<T>): Promise<T> {
    for (let attempt = 1; ; attempt++) {
      try {
        session ??= await withTimeout(gateway.connectGateway(), "Connecting to Grok Bot");
        return await withTimeout(fn(session), label);
      } catch (err) {
        const status = (err as { status?: number }).status;
        const retryable = status === undefined || status === 401 || status === 403 || status === 404 || status >= 500;
        // The app rotates its token and the cloud computer's URL can change; re-read the session.
        if (retryable) session = undefined;
        if (attempt >= 2 || !retryable) throw err;
      }
    }
  }

  return {
    async listBots() {
      const agents = await call("Listing bots", (s) => gateway.listAgents(s));
      return agents.map((a) => ({ id: a.id, name: a.name, title: a.title, isGroup: a.isGroup }));
    },
    async sendPrompt(botId, prompt, clientNonce) {
      await call("Sending to Grok Bot", (s) => gateway.gatewayCall(s, "sendPrompt", { agentId: botId, prompt, clientNonce }));
    },
    transcriptTail(botId, limit) {
      return call("Reading transcript", (s) => gateway.gatewayCall(s, "getAgentTranscriptTail", { id: botId, limit }));
    },
  };
}

export function findBot(bots: GrokBotSummary[], ref: string): GrokBotSummary | undefined {
  const needle = ref.trim().toLowerCase();
  return (
    bots.find((b) => b.id.toLowerCase() === needle) ??
    bots.find((b) => b.name.toLowerCase() === needle) ??
    bots.find((b) => b.title.toLowerCase() === needle)
  );
}

/** Deterministic UUID for a message guid, so a retried send doesn't post twice. */
export function nonceFor(guid: string): string {
  const h = createHash("sha1").update(`iagents:${guid}`).digest("hex");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-5${h.slice(13, 16)}-${((parseInt(h[16], 16) & 0x3) | 0x8).toString(16)}${h.slice(17, 20)}-${h.slice(20, 32)}`;
}

type BotState = {
  contact: BotContact;
  id?: string;
  isGroup: boolean;
  tracker: TranscriptTracker;
  nextPollAt: number;
  activeUntil: number;
  polling: boolean;
  baselined: boolean;
  /** Text already texted per entry id, so a message that grows later can be continued. */
  relayed: Map<string, string>;
};

export type GrokBotBridgeDeps = {
  api: GrokBotApi;
  state: State;
  outbox: Outbox;
  config: Config;
  now: () => number;
};

const ERROR_NOTICE_INTERVAL_MS = 10 * 60_000;
const RESOLVE_RETRY_MS = 60_000;

/**
 * Texts become prompts to a Grok Bot bot; anything the bot posts to its conversation
 * (replies, routine reports, approval requests) is relayed back over iMessage.
 */
export class GrokBotBridge {
  #deps: GrokBotBridgeDeps;
  #bots = new Map<string, BotState>();
  #lastErrorNotice = new Map<string, number>();
  #lastResolveAt = 0;

  constructor(deps: GrokBotBridgeDeps) {
    this.#deps = deps;
    for (const contact of deps.config.bots) {
      this.#bots.set(contact.name, {
        contact,
        isGroup: false,
        tracker: new TranscriptTracker(deps.config.poll.stableMs),
        nextPollAt: 0,
        activeUntil: 0,
        polling: false,
        baselined: false,
        relayed: new Map(),
      });
    }
  }

  /** Resolves bot names to ids and records what's already in each transcript so old messages aren't replayed. */
  async start(): Promise<void> {
    await this.#resolve();
    for (const bot of this.#bots.values()) await this.#ensureBaseline(bot).catch((err) => log.warn(`Couldn't read ${bot.contact.name}'s transcript yet`, err));
  }

  async #resolve(): Promise<void> {
    this.#lastResolveAt = this.#deps.now();
    const all = await this.#deps.api.listBots();
    for (const bot of this.#bots.values()) {
      const match = findBot(all, bot.contact.grokBot);
      if (match) {
        bot.id = match.id;
        bot.isGroup = match.isGroup;
        log.info(`${bot.contact.name} → Grok Bot "${match.name}"${match.isGroup ? " (group)" : ""}`);
      } else {
        log.warn(`No Grok Bot bot named "${bot.contact.grokBot}" (for ${bot.contact.name}). Available: ${all.map((b) => b.name).join(", ") || "none"}`);
      }
    }
  }

  async #ensureBaseline(bot: BotState): Promise<void> {
    if (bot.baselined || !bot.id) return;
    const key = `grokbot:baseline:${bot.id}`;
    if (!this.#deps.state.getKv(key)) {
      const entries = await this.#entries(bot.id);
      this.#deps.state.markSeen(bot.id, entries.map((e) => e.id), this.#deps.now());
      this.#deps.state.setKv(key, String(this.#deps.now()));
    }
    bot.baselined = true;
  }

  async #entries(botId: string): Promise<TranscriptEntry[]> {
    const payload = await this.#deps.api.transcriptTail(botId, this.#deps.config.poll.transcriptLimit);
    return chronological(
      extractEntries(payload)
        .map(parseEntry)
        .filter((e): e is TranscriptEntry => e !== undefined),
    );
  }

  async handle(contact: BotContact, message: InboundMessage): Promise<void> {
    const bot = this.#bots.get(contact.name);
    if (!bot) return;
    const { state, api, config, now } = this.#deps;
    state.setKv(`lastSender:${contact.name}`, message.sender);
    try {
      if (!bot.id) await this.#resolve();
      if (!bot.id) throw new Error(`there's no Grok Bot bot named "${contact.grokBot}"`);
      await this.#ensureBaseline(bot);
      const prompt = message.quotedText ? `(Replying to: "${truncate(message.quotedText, 300)}")\n\n${message.text}` : message.text;
      // Mark the conversation active before sending, so even an instant reply counts as a reply.
      bot.activeUntil = now() + config.poll.activeWindowMs;
      await api.sendPrompt(bot.id, prompt, nonceFor(message.guid));
      bot.nextPollAt = Math.min(bot.nextPollAt, now() + config.poll.grokBotActiveMs);
      log.info(`→ ${contact.name}: sent prompt (${message.text.length} chars)`);
    } catch (err) {
      log.error(`Couldn't send to Grok Bot for ${contact.name}`, err);
      this.#notifyError(contact, message.sender, `Couldn't reach ${contact.grokBot} in Grok Bot (${truncate(errorMessage(err), 160)}). Check that the Grok Bot app is open and signed in.`);
    }
  }

  async poll(): Promise<void> {
    const t = this.#deps.now();
    const unresolved = [...this.#bots.values()].some((b) => !b.id);
    if (unresolved && t - this.#lastResolveAt >= RESOLVE_RETRY_MS) {
      await this.#resolve().catch((err) => log.warn("Still can't list Grok Bot bots", err));
    }
    const due = [...this.#bots.values()].filter((b) => b.id && !b.polling && t >= b.nextPollAt);
    await Promise.all(due.map((b) => this.#pollBot(b)));
  }

  async #pollBot(bot: BotState): Promise<void> {
    const { state, outbox, config, now } = this.#deps;
    const botId = bot.id!;
    bot.polling = true;
    try {
      if (!bot.baselined) {
        await this.#ensureBaseline(bot);
        return;
      }
      const entries = await this.#entries(botId);
      const t = now();
      const fullText = new Map(entries.map((entry) => [entry.id, entry.text]));
      // Continuations follow the same settling, ordering, and routing rules as new messages.
      const pending = entries.map((entry) => {
        const previous = bot.relayed.get(entry.id);
        if (previous === undefined) return entry;
        return { ...entry, text: entry.text.startsWith(previous) ? entry.text.slice(previous.length).trim() : "" };
      });
      for (const entry of bot.tracker.ready(pending, t, (id) => state.isSeen(botId, id) && !bot.relayed.has(id))) {
        const active = t < bot.activeUntil;
        if (bot.contact.relay === "replies" && !active) {
          state.markSeen(botId, [entry.id], t);
          // Once a conversation becomes inactive, stop following its old continuations too.
          bot.relayed.delete(entry.id);
          continue;
        }
        if (active) bot.activeUntil = t + config.poll.activeWindowMs;

        let text = bot.isGroup && entry.author ? `${entry.author}: ${entry.text}` : entry.text;
        if (entry.needsApproval) text += "\n\n(Approve or deny this in the Grok Bot app.)";
        const to = state.getKv(`lastSender:${bot.contact.name}`) ?? config.owner.notify;
        log.info(`← ${bot.contact.name}: relaying message (${entry.text.length} chars${active ? "" : ", proactive"})`);
        void outbox.enqueue({
          to,
          botName: bot.contact.name,
          botAddress: bot.contact.address,
          text,
          proactive: !active,
        });
        // enqueue persists synchronously; don't mark an entry seen before it's queued.
        state.markSeen(botId, [entry.id], t);
        bot.relayed.set(entry.id, fullText.get(entry.id)!);
        if (bot.relayed.size > config.poll.transcriptLimit) bot.relayed.delete(bot.relayed.keys().next().value!);
      }
    } catch (err) {
      log.warn(`Couldn't read ${bot.contact.name}'s Grok Bot transcript`, err);
    } finally {
      bot.polling = false;
      const t = now();
      const fast = t < bot.activeUntil || bot.tracker.hasPending();
      bot.nextPollAt = t + (fast ? config.poll.grokBotActiveMs : config.poll.grokBotIdleMs);
    }
  }

  #notifyError(contact: BotContact, to: string, text: string): void {
    const t = this.#deps.now();
    if (t - (this.#lastErrorNotice.get(contact.name) ?? 0) < ERROR_NOTICE_INTERVAL_MS) return;
    this.#lastErrorNotice.set(contact.name, t);
    void this.#deps.outbox.enqueue({ to, botName: contact.name, botAddress: contact.address, text: `⚠️ ${text}`, proactive: false });
  }
}
