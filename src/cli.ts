import { existsSync } from "node:fs";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { loadConfig, PROJECT_ROOT } from "./config.ts";
import { runDoctor } from "./doctor.ts";
import { createGatewayApi, findBot } from "./grokbot/bridge.ts";
import { extractEntries, parseEntry } from "./grokbot/transcript.ts";
import { ChatDb, type MessageStore } from "./imessage/chatdb.ts";
import { AppleScriptSender, ConsoleSender } from "./imessage/sender.ts";
import { installService, LOG_PATH, PLIST_PATH, uninstallService } from "./launchd.ts";
import { errorMessage, log, setLogLevel } from "./log.ts";
import { Relay } from "./relay.ts";
import { State } from "./state.ts";

const USAGE = `iagents: text your Grok Bot bots from iMessage

Usage:
  iagents doctor                 check permissions, Grok Bot, and config
  iagents bots                   list the bots and groups in your Grok Bot app
  iagents run [--dry-run]        run the relay in the foreground (--dry-run prints replies instead of texting)
  iagents simulate <bot> <text>  message a bot without iMessage and print its replies
  iagents probe <grok-bot-name>  print a bot's raw recent transcript (for debugging relaying)
  iagents send <handle> <text>   send a test iMessage from this Mac
  iagents install                install and start the background service (launchd)
  iagents uninstall              stop and remove the background service
`;

const envFile = join(PROJECT_ROOT, ".env");
if (existsSync(envFile)) process.loadEnvFile(envFile);

async function run(dryRun: boolean): Promise<void> {
  const config = loadConfig();
  setLogLevel(config.logLevel);
  const state = new State(dryRun ? join(config.stateDir, "dry-run") : config.stateDir);
  const messages = new ChatDb(config.chatDbPath);
  const relay = new Relay({
    config,
    messages,
    state,
    sender: dryRun ? new ConsoleSender() : new AppleScriptSender(),
    grokBot: await createGatewayApi(),
  });
  const controller = new AbortController();
  process.once("SIGINT", () => controller.abort());
  process.once("SIGTERM", () => controller.abort());
  if (dryRun) log.info("Dry run: replies are printed here, not texted");
  await relay.run(controller.signal);
  messages.close();
  state.close();
}

/** A Messages store with no history, for runs that don't touch iMessage. */
const noMessages: MessageStore = {
  maxRowId: () => 0,
  rowsAfter: () => [],
  messageText: () => undefined,
  oneToOneChats: () => [],
  close: () => {},
};

async function simulate(botName: string, text: string): Promise<void> {
  const config = loadConfig();
  setLogLevel(config.logLevel);
  const sender = new ConsoleSender();
  const relay = new Relay({
    config: { ...config, schedules: [], quietHours: undefined },
    messages: noMessages,
    state: new State(":memory:"),
    sender,
    grokBot: await createGatewayApi(),
  });
  await relay.start();
  relay.inject(botName, text);

  // Print replies as they come; stop after 30s of quiet once something arrived, or after 10 minutes.
  const started = Date.now();
  let seen = 0;
  let lastChange = Date.now();
  while (Date.now() - started < 10 * 60_000) {
    await relay.tick();
    if (sender.sent !== seen) {
      seen = sender.sent;
      lastChange = Date.now();
    }
    if (seen > 0 && Date.now() - lastChange > 30_000) break;
    await delay(1000);
  }
  await relay.idle();
  if (seen === 0) console.log("\nNo reply within 10 minutes. Run `iagents probe` to see what the bot posted.");
}

async function listBots(): Promise<void> {
  const bots = await (await createGatewayApi()).listBots();
  if (bots.length === 0) return console.log("No bots in your Grok Bot app yet.");
  for (const b of bots) console.log(`${b.isGroup ? "group" : "bot  "}  ${b.name}${b.title ? ` (${b.title})` : ""}`);
}

function shorten(value: unknown): unknown {
  if (typeof value === "string") return value.length > 240 ? `${value.slice(0, 240)}… (${value.length} chars)` : value;
  if (Array.isArray(value)) return value.map(shorten);
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, shorten(v)]));
  return value;
}

async function probe(ref: string): Promise<void> {
  const api = await createGatewayApi();
  const bot = findBot(await api.listBots(), ref);
  if (!bot) throw new Error(`No Grok Bot bot named "${ref}". Run \`iagents bots\`.`);
  const payload = await api.transcriptTail(bot.id, 10);
  console.log("Raw transcript (strings shortened):");
  console.log(JSON.stringify(shorten(payload), null, 2));
  console.log("\nHow iAgents reads it (only role=bot entries are texted to you):");
  for (const entry of extractEntries(payload).map(parseEntry)) {
    if (!entry) continue;
    console.log(`  ${entry.role.padEnd(5)} complete=${String(entry.complete).padEnd(5)} ${entry.text.replace(/\s+/g, " ").slice(0, 90)}`);
  }
}

const [command, ...args] = process.argv.slice(2);
try {
  switch (command) {
    case "run":
      await run(args.includes("--dry-run"));
      break;
    case "doctor":
      process.exitCode = (await runDoctor()) ? 0 : 1;
      break;
    case "bots":
      await listBots();
      break;
    case "simulate":
      if (args.length < 2) throw new Error("Usage: iagents simulate <bot> <text>");
      await simulate(args[0], args.slice(1).join(" "));
      break;
    case "probe":
      if (!args[0]) throw new Error("Usage: iagents probe <grok-bot-name>");
      await probe(args.join(" "));
      break;
    case "send":
      if (args.length < 2) throw new Error("Usage: iagents send <handle> <text>");
      await new AppleScriptSender().send({ handle: args[0] }, args.slice(1).join(" "));
      console.log("Sent.");
      break;
    case "install":
      await installService();
      console.log(`Installed and started ${PLIST_PATH}\nLogs: ${LOG_PATH}\nGrant Full Disk Access to ${process.execPath} if you haven't yet.`);
      break;
    case "uninstall":
      await uninstallService();
      console.log("Background service removed.");
      break;
    default:
      console.log(USAGE);
      if (command && !["help", "--help", "-h"].includes(command)) process.exitCode = 1;
  }
} catch (err) {
  console.error(`Error: ${errorMessage(err)}`);
  process.exitCode = 1;
}
