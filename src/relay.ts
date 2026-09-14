import { setTimeout as delay } from "node:timers/promises";
import type { BotContact, Config } from "./config.ts";
import { GrokBotBridge, type GrokBotApi } from "./grokbot/bridge.ts";
import { handlesMatch, maskHandle } from "./handles.ts";
import type { MessageRow, MessageStore } from "./imessage/chatdb.ts";
import { Outbox } from "./imessage/outbox.ts";
import type { Sender } from "./imessage/sender.ts";
import { MessagesWatcher } from "./imessage/watcher.ts";
import { log } from "./log.ts";
import { routeMessage, type InboundMessage } from "./router.ts";
import type { State } from "./state.ts";
import { dueSchedules, localDay } from "./time.ts";

/** Messages older than this when first seen (e.g. the Mac was asleep) are skipped, not answered late. */
const MAX_MESSAGE_AGE_MS = 15 * 60_000;
const WAKE_GAP_MS = 60_000;

export type RelayDeps = {
  config: Config;
  messages: MessageStore;
  state: State;
  sender: Sender;
  grokBot: GrokBotApi;
  now?: () => Date;
};

/** Watches Messages for texts to the bots, hands them to Grok Bot, and texts back what the bots post. */
export class Relay {
  readonly outbox: Outbox;
  #config: Config;
  #messages: MessageStore;
  #state: State;
  #now: () => Date;
  #bridge: GrokBotBridge;
  #lastRowId: number | undefined;
  #lastDbErrorAt = 0;
  #queues = new Map<string, Promise<void>>();
  #watcher: MessagesWatcher;
  #lastTickAt: number;
  #startedAt: Date;

  constructor(deps: RelayDeps) {
    this.#config = deps.config;
    this.#messages = deps.messages;
    this.#state = deps.state;
    this.#now = deps.now ?? (() => new Date());
    this.#startedAt = this.#now();
    this.#lastTickAt = this.#startedAt.getTime();
    this.#watcher = new MessagesWatcher(deps.config.chatDbPath, () => this.pollMessages(), () => this.#now().getTime());
    this.outbox = new Outbox({ sender: deps.sender, chats: deps.messages, state: deps.state, config: deps.config, now: this.#now });
    this.#bridge = new GrokBotBridge({
      api: deps.grokBot,
      state: deps.state,
      outbox: this.outbox,
      config: deps.config,
      now: () => this.#now().getTime(),
    });
  }

  async start(): Promise<void> {
    // Capture the cursor before network startup so texts arriving during connection aren't skipped.
    this.pollMessages();
    await this.#bridge.start().catch((err) => log.error("Couldn't connect to Grok Bot yet (will keep trying)", err));
    log.info(`Relay started: ${this.#config.bots.map((b) => `${b.name} → "${b.grokBot}"`).join(", ")}`);
  }

  async tick(): Promise<void> {
    const now = this.#now().getTime();
    const gap = now - this.#lastTickAt;
    this.#lastTickAt = now;
    if (gap > Math.max(WAKE_GAP_MS, this.#config.poll.chatDbMs * 4)) {
      this.#messages.close(); // Reopen the current database/WAL after a long pause.
      this.#watcher.rearm();
      this.#bridge.resumeAfterPause();
      log.info("Relay resumed after a long pause; refreshing Messages and gateway connections");
    }
    this.#watcher.maintain();
    this.pollMessages();
    this.#runSchedules();
    this.#bridge.poll();
    // Both components own and deduplicate their in-flight work. Never wait for the network
    // or Messages.app here; the next database check must run on its own cadence.
    void this.outbox.flushDeferred();
  }

  async run(signal: AbortSignal): Promise<void> {
    const starting = this.start().catch((err) => log.error("Relay startup error", err));
    this.watchMessages();
    while (!signal.aborted) {
      try {
        await this.tick();
      } catch (err) {
        log.error("Relay loop error", err);
      }
      await delay(this.#config.poll.chatDbMs, undefined, { signal }).catch(() => {});
    }
    this.stopWatching();
    await starting;
    await this.idle();
    log.info("Relay stopped");
  }

  /**
   * Picks up texts the moment Messages writes them, instead of on the next poll. The regular
   * poll stays as a safety net, since file events can be missed or unsupported.
   */
  watchMessages(): void {
    this.#watcher.start();
  }

  stopWatching(): void {
    this.#watcher.stop();
  }

  /** Drains prompts, transcript reads, and outgoing messages, including during shutdown. */
  async idle(): Promise<void> {
    for (;;) {
      const snapshot = [...this.#queues.values()];
      await Promise.all(snapshot);
      await this.#bridge.idle();
      await this.outbox.idle();
      const current = [...this.#queues.values()];
      if (current.length === snapshot.length && current.every((p, i) => p === snapshot[i])) return;
    }
  }

  /** Sends text to a bot as if you'd texted it (used by `iagents simulate`). */
  inject(botName: string, text: string): void {
    const bot = this.#config.bots.find((b) => b.name.toLowerCase() === botName.toLowerCase());
    if (!bot) throw new Error(`No bot named "${botName}" in config`);
    const now = this.#now();
    this.#dispatch(bot, { guid: `simulate:${now.getTime()}`, sender: this.#config.owner.notify, text, destination: bot.address, lastAddressedHandle: "", sentAt: now });
  }

  pollMessages(): void {
    const now = this.#now();
    let rows: MessageRow[];
    try {
      if (this.#lastRowId === undefined) {
        const value = this.#state.getKv("chatdb:lastRowId");
        const saved = Number(value);
        this.#lastRowId = value !== undefined && Number.isSafeInteger(saved) && saved >= 0 ? saved : this.#messages.maxRowId();
        this.#state.setKv("chatdb:lastRowId", String(this.#lastRowId));
      }
      rows = this.#messages.rowsAfter(this.#lastRowId);
    } catch (err) {
      if (now.getTime() - this.#lastDbErrorAt > 5 * 60_000) {
        log.error(`Can't read the Messages database. Grant Full Disk Access to ${process.execPath}`, err);
        this.#lastDbErrorAt = now.getTime();
      }
      this.#messages.close();
      return;
    }
    let last = this.#lastRowId;
    for (const row of rows) {
      last = Math.max(last, row.rowId);
      if (row.isFromMe) this.#recordSent(row, now);
      else this.#receive(row, now);
    }
    if (last !== this.#lastRowId) {
      this.#lastRowId = last;
      this.#state.setKv("chatdb:lastRowId", String(last));
    }
  }

  /** Ties a message iAgents just sent to the bot that sent it, so swipe-replies route back to that bot. */
  #recordSent(row: MessageRow, now: Date): void {
    if (!row.text) return;
    const botName = this.#state.takePendingSent(row.handle, row.text, now.getTime());
    if (botName) this.#state.setSentBot(row.guid, botName, now.getTime());
  }

  #receive(row: MessageRow, now: Date): void {
    if (row.isReaction || row.isSystem || row.isGroup) return;
    if (!this.#config.owner.handles.some((h) => handlesMatch(h, row.handle))) {
      log.info(`Ignoring a message from ${maskHandle(row.handle)} (not in owner.handles)`);
      return;
    }
    if (now.getTime() - row.sentAt.getTime() > MAX_MESSAGE_AGE_MS) {
      log.info(`Skipping a message from ${row.sentAt.toISOString()} (too old to answer)`);
      return;
    }

    const message: InboundMessage = {
      guid: row.guid,
      sender: row.handle,
      text: row.text,
      destination: row.destination,
      lastAddressedHandle: row.lastAddressedHandle,
      sentAt: row.sentAt,
    };
    const repliedToBot = row.threadOriginatorGuid ? this.#state.getSentBot(row.threadOriginatorGuid) : undefined;
    const route = routeMessage(message, repliedToBot, this.#config);
    if (!route) {
      log.warn(`No bot matches address ${maskHandle(row.destination)}; set defaultBot or check bots[].address`);
      return;
    }

    if (!row.text) {
      if (row.hasAttachments) this.#reply(route.bot, message, "I can only pass along text for now, so that attachment wasn't sent.");
      return;
    }
    if (route.text.toLowerCase() === "/ping") {
      this.#reply(route.bot, message, `pong: iAgents relay has been up since ${this.#startedAt.toLocaleString()}.`);
      return;
    }
    if (row.threadOriginatorGuid) message.quotedText = this.#messages.messageText(row.threadOriginatorGuid);
    log.info(`${maskHandle(row.handle)} → ${route.bot.name}`);
    this.#dispatch(route.bot, { ...message, text: route.text });
  }

  #runSchedules(): void {
    const now = this.#now();
    for (const schedule of dueSchedules(this.#config.schedules, now, (name, day) => this.#state.hasScheduleRun(name, day))) {
      const day = localDay(now);
      this.#state.markScheduleRun(schedule.name, day);
      const bot = this.#config.bots.find((b) => b.name === schedule.bot);
      if (!bot) continue;
      log.info(`Running schedule "${schedule.name}"`);
      this.#dispatch(bot, {
        guid: `schedule:${schedule.name}:${day}`,
        sender: this.#config.owner.notify,
        text: schedule.prompt,
        destination: bot.address,
        lastAddressedHandle: "",
        sentAt: now,
      });
    }
  }

  /** Prompts for one bot go out one at a time, in order, without blocking other bots. */
  #dispatch(bot: BotContact, message: InboundMessage): void {
    const next = (this.#queues.get(bot.name) ?? Promise.resolve())
      .then(() => this.#bridge.handle(bot, message))
      .catch((err) => log.error(`Handling a message for ${bot.name} failed`, err));
    this.#queues.set(bot.name, next);
  }

  #reply(bot: BotContact, message: InboundMessage, text: string): void {
    void this.outbox.enqueue({ to: message.sender, botName: bot.name, botAddress: bot.address, text, proactive: false });
  }
}
