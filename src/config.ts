import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { handlesMatch, normalizeHandle } from "./handles.ts";
import { parseJsonc } from "./jsonc.ts";
import { isLogLevel, type LogLevel } from "./log.ts";
import { parseClock, parseDays, type QuietHours, type Schedule } from "./time.ts";

export const PROJECT_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
export const DEFAULT_CONFIG_PATH = join(PROJECT_ROOT, "config.jsonc");

/** One iMessage contact, backed by a bot (or group) in the Grok Bot app. */
export type BotContact = {
  /** One word; shown as "[Name]" when needed and usable as "@Name" in texts. */
  name: string;
  /** The iMessage address you text for this bot (an address on the bot Apple ID). */
  address: string;
  /** Name or id of the bot or group in the Grok Bot app. */
  grokBot: string;
  /** "all" relays everything the bot posts (routines, reports, agent updates); "replies" only answers to your texts. */
  relay: "all" | "replies";
};

export type Config = {
  owner: { handles: string[]; notify: string };
  bots: BotContact[];
  defaultBot?: string;
  schedules: Schedule[];
  quietHours?: QuietHours;
  tagReplies: "auto" | "always" | "never";
  maxMessageLength: number;
  chatDbPath: string;
  stateDir: string;
  logLevel: LogLevel;
  poll: {
    chatDbMs: number;
    grokBotActiveMs: number;
    grokBotIdleMs: number;
    activeWindowMs: number;
    stableMs: number;
    transcriptLimit: number;
  };
};

export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConfigError";
  }
}

export function loadConfig(path = process.env.IAGENTS_CONFIG || DEFAULT_CONFIG_PATH): Config {
  if (!existsSync(path)) {
    throw new ConfigError(`No config at ${path}. Copy config.example.jsonc to config.jsonc and fill it in.`);
  }
  let raw: unknown;
  try {
    raw = parseJsonc(readFileSync(path, "utf8"));
  } catch (err) {
    throw new ConfigError(`${path} is not valid JSON: ${err instanceof Error ? err.message : err}`);
  }
  return validateConfig(raw);
}

type Obj = Record<string, unknown>;

function isObj(value: unknown): value is Obj {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function str(obj: Obj, key: string, where: string, required = true): string | undefined {
  const value = obj[key];
  if (value === undefined || value === null || value === "") {
    if (required) throw new ConfigError(`${where}.${key} is required`);
    return undefined;
  }
  if (typeof value !== "string") throw new ConfigError(`${where}.${key} must be a string`);
  return value.trim();
}

function num(obj: Obj | undefined, key: string, fallback: number, min: number): number {
  const value = obj?.[key];
  if (value === undefined) return fallback;
  if (typeof value !== "number" || !Number.isFinite(value) || value < min) {
    throw new ConfigError(`${key} must be a number >= ${min}`);
  }
  return value;
}

function oneOf<T extends string>(value: unknown, allowed: readonly T[], fallback: T, where: string): T {
  if (value === undefined) return fallback;
  if (typeof value === "string" && (allowed as readonly string[]).includes(value)) return value as T;
  throw new ConfigError(`${where} must be one of: ${allowed.join(", ")}`);
}

function expandHome(path: string): string {
  return path.startsWith("~/") ? join(homedir(), path.slice(2)) : path;
}

export function validateConfig(raw: unknown): Config {
  if (!isObj(raw)) throw new ConfigError("Config must be a JSON object");

  if (!isObj(raw.owner)) throw new ConfigError("owner is required");
  const handlesRaw = raw.owner.handles;
  if (!Array.isArray(handlesRaw) || handlesRaw.length === 0 || !handlesRaw.every((h) => typeof h === "string" && normalizeHandle(h))) {
    throw new ConfigError("owner.handles must list your phone number and/or Apple ID email");
  }
  const handles = handlesRaw.map((h: string) => h.trim());
  const notify = str(raw.owner, "notify", "owner", false) ?? handles[0];

  if (!Array.isArray(raw.bots) || raw.bots.length === 0) throw new ConfigError("bots must list at least one bot");
  const bots = raw.bots.map((bot, i) => validateBot(bot, `bots[${i}]`));
  const names = new Set<string>();
  for (const bot of bots) {
    const key = bot.name.toLowerCase();
    if (names.has(key)) throw new ConfigError(`Two bots are named "${bot.name}"`);
    names.add(key);
    if (handles.some((h) => handlesMatch(h, bot.address))) {
      throw new ConfigError(`${bot.name}.address is one of your own owner.handles; bots need their own address`);
    }
  }
  const botAddresses = bots.map((b) => normalizeHandle(b.address));
  if (new Set(botAddresses).size !== botAddresses.length) {
    throw new ConfigError("Each bot needs a different address");
  }

  const defaultBot = typeof raw.defaultBot === "string" ? raw.defaultBot : undefined;
  if (defaultBot && !names.has(defaultBot.toLowerCase())) throw new ConfigError(`defaultBot "${defaultBot}" isn't in bots`);

  const schedules = (Array.isArray(raw.schedules) ? raw.schedules : []).map((s, i): Schedule => {
    const where = `schedules[${i}]`;
    if (!isObj(s)) throw new ConfigError(`${where} must be an object`);
    const bot = str(s, "bot", where)!;
    const match = bots.find((b) => b.name.toLowerCase() === bot.toLowerCase());
    if (!match) throw new ConfigError(`${where}.bot "${bot}" isn't in bots`);
    const time = str(s, "time", where)!;
    if (parseClock(time) === undefined) throw new ConfigError(`${where}.time must be "HH:MM" (24-hour)`);
    const days = parseDays(s.days);
    if (!days) throw new ConfigError(`${where}.days must be "daily", "weekdays", "weekends", or a list like ["mon","thu"]`);
    return { name: str(s, "name", where, false) ?? `${match.name} ${time}`, bot: match.name, time, days, prompt: str(s, "prompt", where)! };
  });

  let quietHours: QuietHours | undefined;
  if (raw.quietHours !== undefined) {
    if (!isObj(raw.quietHours)) throw new ConfigError("quietHours must be { start, end }");
    const start = str(raw.quietHours, "start", "quietHours")!;
    const end = str(raw.quietHours, "end", "quietHours")!;
    if (parseClock(start) === undefined || parseClock(end) === undefined) throw new ConfigError('quietHours times must be "HH:MM"');
    quietHours = { start, end };
  }

  const poll = isObj(raw.poll) ? raw.poll : undefined;
  const logLevel = raw.logLevel === undefined ? "info" : raw.logLevel;
  if (!isLogLevel(logLevel)) throw new ConfigError("logLevel must be debug, info, warn, or error");

  return {
    owner: { handles, notify },
    bots,
    defaultBot: defaultBot ? bots.find((b) => b.name.toLowerCase() === defaultBot.toLowerCase())!.name : undefined,
    schedules,
    quietHours,
    tagReplies: oneOf(raw.tagReplies, ["auto", "always", "never"] as const, "auto", "tagReplies"),
    maxMessageLength: num(raw, "maxMessageLength", 3000, 200),
    chatDbPath: expandHome(typeof raw.chatDbPath === "string" ? raw.chatDbPath : "~/Library/Messages/chat.db"),
    stateDir: expandHome(typeof raw.stateDir === "string" ? raw.stateDir : "~/Library/Application Support/iAgents"),
    logLevel,
    poll: {
      chatDbMs: num(poll, "chatDbMs", 1500, 250),
      grokBotActiveMs: num(poll, "grokBotActiveMs", 3000, 1000),
      grokBotIdleMs: num(poll, "grokBotIdleMs", 45_000, 5000),
      activeWindowMs: num(poll, "activeWindowMs", 15 * 60_000, 60_000),
      stableMs: num(poll, "stableMs", 2500, 0),
      transcriptLimit: num(poll, "transcriptLimit", 50, 5),
    },
  };
}

function validateBot(raw: unknown, where: string): BotContact {
  if (!isObj(raw)) throw new ConfigError(`${where} must be an object`);
  const name = str(raw, "name", where)!;
  if (!/^\w[\w.-]*$/.test(name)) throw new ConfigError(`${where}.name must be one word (letters, digits, - . _) so you can @mention it`);
  const address = str(raw, "address", where)!;
  if (!normalizeHandle(address)) throw new ConfigError(`${where}.address must be an email or phone number`);
  return {
    name,
    address,
    grokBot: str(raw, "grokBot", `bots.${name}`, false) ?? name,
    relay: oneOf(raw.relay, ["all", "replies"] as const, "all", `bots.${name}.relay`),
  };
}
