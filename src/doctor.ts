import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { loadConfig, type Config } from "./config.ts";
import { createGatewayApi, findBot } from "./grokbot/bridge.ts";
import { ChatDb } from "./imessage/chatdb.ts";
import { LOG_PATH, serviceStatus } from "./launchd.ts";
import { errorMessage } from "./log.ts";

const execFileAsync = promisify(execFile);

type Result = "ok" | "warn" | "fail";

function report(result: Result, title: string, detail = ""): Result {
  const icon = { ok: "✓", warn: "!", fail: "✗" }[result];
  process.stdout.write(`${icon} ${title}${detail ? `\n    ${detail.replace(/\n/g, "\n    ")}` : ""}\n`);
  return result;
}

/** Checks every moving part and explains how to fix what's broken. Returns false if anything failed. */
export async function runDoctor(): Promise<boolean> {
  const results: Result[] = [];

  const [major, minor] = process.versions.node.split(".").map(Number);
  results.push(
    major > 23 || (major === 23 && minor >= 6)
      ? report("ok", `Node ${process.versions.node}`)
      : report("fail", `Node ${process.versions.node} is too old`, "iAgents needs Node 23.6 or newer (brew upgrade node)."),
  );

  let config: Config | undefined;
  try {
    config = loadConfig();
    results.push(report("ok", `Config: ${config.bots.map((b) => `${b.name} (${b.address}) → "${b.grokBot}"`).join(", ")}`));
  } catch (err) {
    results.push(report("fail", "Config", errorMessage(err)));
  }
  if (!config) return false;

  const db = new ChatDb(config.chatDbPath);
  try {
    results.push(report("ok", `Messages database readable (${db.maxRowId()} messages)`));
    for (const bot of config.bots) {
      const count = db.countForAddress(bot.address);
      results.push(
        count > 0
          ? report("ok", `${bot.address} has received messages (${count})`)
          : report(
              "warn",
              `No messages to ${bot.address} yet`,
              "Text it once from your phone. If nothing arrives, add the address to the bot Apple ID\nand tick it under Messages → Settings → iMessage → \"You can be reached at\".",
            ),
      );
    }
  } catch (err) {
    results.push(
      report(
        "fail",
        "Can't read the Messages database",
        `${errorMessage(err)}\nSystem Settings → Privacy & Security → Full Disk Access, and add:\n  • ${process.execPath} (used by the background service)\n  • the terminal app you run iagents from (for manual runs)`,
      ),
    );
  } finally {
    db.close();
  }

  try {
    // Same account lookup the send script uses.
    await execFileAsync("osascript", ["-e", 'tell application "Messages" to get id of (1st account whose service type = iMessage)'], { timeout: 20_000 });
    results.push(report("ok", "Messages can be automated and has an iMessage account"));
  } catch (err) {
    const message = errorMessage(err);
    results.push(
      /-1743|not allowed|not authorized/i.test(message)
        ? report("fail", "Not allowed to control Messages", "System Settings → Privacy & Security → Automation → allow Messages for your terminal and for node.")
        : report("fail", "No iMessage account found in Messages", `Sign Messages into the bot Apple ID.\n${message.trim()}`),
    );
  }

  try {
    const bots = await (await createGatewayApi()).listBots();
    results.push(report("ok", `Grok Bot session works (${bots.map((b) => b.name).join(", ") || "no bots yet"})`));
    for (const contact of config.bots) {
      const match = findBot(bots, contact.grokBot);
      results.push(
        match
          ? report("ok", `${contact.name} → Grok Bot "${match.name}"${match.isGroup ? " (group)" : ""}`)
          : report("fail", `${contact.name}: no Grok Bot bot named "${contact.grokBot}"`, "Set grokBot to one of the names above."),
      );
    }
  } catch (err) {
    results.push(
      report(
        "fail",
        "Can't reach Grok Bot",
        `${errorMessage(err)}\nOpen the Grok Bot app and sign in. When macOS asks to use "Grok Bot Safe Storage",\nchoose Always Allow so the service can run unattended.`,
      ),
    );
  }

  const service = await serviceStatus();
  results.push(
    service === "running"
      ? report("ok", `Background service running (logs: ${LOG_PATH})`)
      : report("warn", `Background service ${service}`, "Run `iagents install` once everything above passes."),
  );

  return !results.includes("fail");
}
