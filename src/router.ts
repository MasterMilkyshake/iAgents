import type { BotContact, Config } from "./config.ts";
import { handlesMatch } from "./handles.ts";

export type InboundMessage = {
  guid: string;
  sender: string;
  text: string;
  /** Local address you texted (one of the bot account's addresses). */
  destination: string;
  lastAddressedHandle: string;
  /** Text of the message you swipe-replied to, if any. */
  quotedText?: string;
  sentAt: Date;
};

export type Route = { bot: BotContact; text: string };

/**
 * Picks the bot for an incoming text, in order:
 *   1. "@Name ..." at the start of the message
 *   2. a swipe-reply to a message a bot sent
 *   3. the address you texted
 *   4. `defaultBot`, or the only bot
 */
export function routeMessage(message: InboundMessage, repliedToBot: string | undefined, config: Config): Route | undefined {
  const byName = (name: string | undefined) => (name ? config.bots.find((b) => b.name.toLowerCase() === name.toLowerCase()) : undefined);

  const mention = /^@([\w.-]+)[\s,:]+([\s\S]+)$/.exec(message.text.trim());
  const mentioned = byName(mention?.[1]);
  if (mention && mentioned) return { bot: mentioned, text: mention[2].trim() };

  const byAddress = (address: string) => (address ? config.bots.find((b) => handlesMatch(b.address, address)) : undefined);
  const bot =
    byName(repliedToBot) ??
    byAddress(message.destination) ??
    byAddress(message.lastAddressedHandle) ??
    byName(config.defaultBot) ??
    (config.bots.length === 1 ? config.bots[0] : undefined);
  return bot ? { bot, text: message.text } : undefined;
}
