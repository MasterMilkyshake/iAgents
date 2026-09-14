import type { Config } from "../config.ts";
import { chunkText, markdownToText } from "../format.ts";
import { handlesMatch } from "../handles.ts";
import { log } from "../log.ts";
import type { State } from "../state.ts";
import { isQuietTime } from "../time.ts";
import type { ChatInfo } from "./chatdb.ts";
import type { Sender } from "./sender.ts";

export type OutgoingMessage = {
  to: string;
  botName: string;
  botAddress: string;
  text: string;
  /** Not a reply to something you just sent (reports, agent results). Held during quiet hours. */
  proactive: boolean;
};

type QueuedMessage = OutgoingMessage & { remainingChunks?: string[] };
const RETRY_MS = 30_000;

export type OutboxDeps = {
  sender: Sender;
  chats: { oneToOneChats(handle: string): ChatInfo[] };
  state: State;
  config: Config;
  now: () => Date;
};

/**
 * Serializes everything iAgents sends so bubbles arrive in order.
 *
 * Messages.app sends from whichever of the bot account's addresses the chat was last
 * addressed to. When that isn't this bot's address (you just texted a different bot and
 * the Mac merged both into one chat), the message is prefixed with "[BotName]" so it's
 * still clear who is talking.
 */
export class Outbox {
  #deps: OutboxDeps;
  #chain: Promise<void> = Promise.resolve();
  #queued = new Set<number>();
  #retryAt = new Map<number, number>();

  constructor(deps: OutboxDeps) {
    this.#deps = deps;
  }

  enqueue(message: OutgoingMessage): Promise<void> {
    // Persist before scheduling asynchronous work, including ordinary replies.
    const id = this.#deps.state.deferMessage(message, this.#deps.now().getTime());
    return this.#queue(id, { ...message });
  }

  #queue(id: number, message: QueuedMessage): Promise<void> {
    if (this.#queued.has(id)) return this.#chain;
    this.#queued.add(id);
    this.#chain = this.#chain
      .then(async () => {
        if (await this.#deliver(id, message)) {
          this.#deps.state.removeDeferred(id);
          this.#retryAt.delete(id);
        }
      })
      .catch((err) => {
        this.#retryAt.set(id, this.#deps.now().getTime() + RETRY_MS);
        log.error(`Failed to send ${message.botName} message (queued for retry)`, err);
      })
      .finally(() => this.#queued.delete(id));
    return this.#chain;
  }

  idle(): Promise<void> {
    return this.#chain;
  }

  /** Resumes persisted messages after quiet hours, a failed send, or a restart. */
  flushDeferred(): Promise<void> {
    const { state, config, now } = this.#deps;
    const t = now();
    for (const { id, payload } of state.deferredMessages()) {
      const message = payload as QueuedMessage;
      if (t.getTime() < (this.#retryAt.get(id) ?? 0)) continue;
      if (message.proactive && isQuietTime(config.quietHours, t)) continue;
      this.#queue(id, message);
    }
    return this.#chain;
  }

  async #deliver(id: number, message: QueuedMessage): Promise<boolean> {
    const { sender, chats, state, config, now } = this.#deps;
    if (message.proactive && isQuietTime(config.quietHours, now())) {
      log.info(`Holding a ${message.botName} message until quiet hours end`);
      return false;
    }

    let known: ChatInfo[] = [];
    try {
      known = chats.oneToOneChats(message.to);
    } catch (err) {
      log.warn("Couldn't look up existing chats; sending by handle", err);
    }
    const own = known.find((chat) => handlesMatch(chat.lastAddressedHandle, message.botAddress));
    const chat = own ?? (known.length === 1 ? known[0] : undefined);
    const tag = config.tagReplies === "always" || (config.tagReplies === "auto" && config.bots.length > 1 && !own);

    const body = markdownToText(message.text);
    if (!body) return true;
    message.remainingChunks ??= chunkText(tag ? `[${message.botName}] ${body}` : body, config.maxMessageLength);
    while (message.remainingChunks.length) {
      const chunk = message.remainingChunks[0];
      await sender.send({ handle: message.to, chatGuid: chat?.guid }, chunk);
      state.addPendingSent(message.to, chunk, message.botName, now().getTime());
      message.remainingChunks.shift();
      state.updateDeferred(id, message);
    }
    return true;
  }
}
