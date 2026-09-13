import { execFile } from "node:child_process";
import { join } from "node:path";
import { promisify } from "node:util";
import { PROJECT_ROOT } from "../config.ts";
import { log } from "../log.ts";

const execFileAsync = promisify(execFile);
const SEND_SCRIPT = join(PROJECT_ROOT, "scripts", "send.applescript");

export type SendTarget = {
  handle: string;
  /** Existing chat to send into; keeps the reply in the thread for that bot's address when possible. */
  chatGuid?: string;
};

export interface Sender {
  send(target: SendTarget, text: string): Promise<void>;
}

export class AppleScriptSender implements Sender {
  async send(target: SendTarget, text: string): Promise<void> {
    if (target.chatGuid) {
      try {
        await execFileAsync("osascript", [SEND_SCRIPT, "chat", target.chatGuid, text], { timeout: 30_000 });
        return;
      } catch (err) {
        log.warn(`Sending into chat ${target.chatGuid} failed, retrying by handle`, err);
      }
    }
    await execFileAsync("osascript", [SEND_SCRIPT, "handle", target.handle, text], { timeout: 30_000 });
  }
}

/** Prints messages instead of sending them (for `run --dry-run` and `simulate`). */
export class ConsoleSender implements Sender {
  sent = 0;

  async send(target: SendTarget, text: string): Promise<void> {
    this.sent++;
    process.stdout.write(`\n--- iMessage to ${target.handle} ---\n${text}\n---\n`);
  }
}
