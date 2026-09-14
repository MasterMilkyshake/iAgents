import { execFile } from "node:child_process";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { promisify } from "node:util";
import { DEFAULT_CONFIG_PATH, loadConfig, PROJECT_ROOT } from "./config.ts";

const execFileAsync = promisify(execFile);

export const LABEL = "com.iagents.relay";
export const PLIST_PATH = join(homedir(), "Library/LaunchAgents", `${LABEL}.plist`);
export const LOG_PATH = join(homedir(), "Library/Logs/iAgents/relay.log");

function xml(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

export function renderPlist(node: string, cli: string, cwd: string, logPath: string, configPath = DEFAULT_CONFIG_PATH): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${LABEL}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${xml(node)}</string>
    <string>${xml(cli)}</string>
    <string>run</string>
  </array>
  <key>WorkingDirectory</key>
  <string>${xml(cwd)}</string>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>ThrottleInterval</key>
  <integer>30</integer>
  <key>ProcessType</key>
  <string>Interactive</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key>
    <string>/usr/bin:/bin:/usr/sbin:/sbin:${xml(dirname(node))}</string>
    <key>IAGENTS_CONFIG</key>
    <string>${xml(configPath)}</string>
  </dict>
  <key>StandardOutPath</key>
  <string>${xml(logPath)}</string>
  <key>StandardErrorPath</key>
  <string>${xml(logPath)}</string>
</dict>
</plist>
`;
}

function domain(): string {
  return `gui/${process.getuid?.() ?? 501}`;
}

export async function installService(): Promise<void> {
  const configPath = resolve(process.env.IAGENTS_CONFIG || DEFAULT_CONFIG_PATH);
  loadConfig(configPath); // Fail before replacing a working service with an invalid config.
  mkdirSync(dirname(PLIST_PATH), { recursive: true });
  mkdirSync(dirname(LOG_PATH), { recursive: true });
  writeFileSync(PLIST_PATH, renderPlist(process.execPath, join(PROJECT_ROOT, "src", "cli.ts"), PROJECT_ROOT, LOG_PATH, configPath));
  await execFileAsync("launchctl", ["bootout", `${domain()}/${LABEL}`]).catch(() => {});
  await execFileAsync("launchctl", ["bootstrap", domain(), PLIST_PATH]);
}

export async function uninstallService(): Promise<void> {
  await execFileAsync("launchctl", ["bootout", `${domain()}/${LABEL}`]).catch(() => {});
  if (existsSync(PLIST_PATH)) rmSync(PLIST_PATH);
}

export async function serviceStatus(): Promise<"running" | "installed" | "not installed"> {
  if (!existsSync(PLIST_PATH)) return "not installed";
  try {
    const { stdout } = await execFileAsync("launchctl", ["print", `${domain()}/${LABEL}`]);
    return /state = running/.test(stdout) ? "running" : "installed";
  } catch {
    return "installed";
  }
}
