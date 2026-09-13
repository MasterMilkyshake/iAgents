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

  constructor(deps: OutboxDeps) {
    this.#deps = deps;
  }

  enqueue(message: OutgoingMessage): Promise<void> {
    this.#chain = this.#chain
      .then(() => this.#deliver(message))
      .catch((err) => log.error(`Failed to send ${message.botName} message`, err));
    return this.#chain;
  }

  idle(): Promise<void> {
    return this.#chain;
  }

  /** Sends anything held during quiet hours once they're over. */
  flushDeferred(): Promise<void> {
    const { state, config, now } = this.#deps;
    if (isQuietTime(config.quietHours, now())) return this.#chain;
    for (const payload of state.takeDeferred()) {
      this.enqueue({ ...(payload as OutgoingMessage), proactive: false });
    }
    return this.#chain;
  }

  async #deliver(message: OutgoingMessage): Promise<void> {
    const { sender, chats, state, config, now } = this.#deps;
    if (message.proactive && isQuietTime(config.quietHours, now())) {
      state.deferMessage(message, now().getTime());
      log.info(`Holding a ${message.botName} message until quiet hours end`);
      return;
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
    if (!body) return;
    for (const chunk of chunkText(tag ? `[${message.botName}] ${body}` : body, config.maxMessageLength)) {
      await sender.send({ handle: message.to, chatGuid: chat?.guid }, chunk);
      state.addPendingSent(message.to, chunk, message.botName, now().getTime());
    }
  }
}
