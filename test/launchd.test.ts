import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { describe, it } from "node:test";
import { renderPlist } from "../src/launchd.ts";

describe("launchd config", () => {
  it("preserves a custom config path and emits valid XML for paths with special characters", { skip: process.platform !== "darwin" }, () => {
    const configPath = '/Users/bot/My Configs/a&b<test>".jsonc';
    const plist = renderPlist("/opt/homebrew/bin/node", "/Users/bot/iAgents/src/cli.ts", "/Users/bot/iAgents", "/Users/bot/relay.log", configPath);
    const parsed = JSON.parse(execFileSync("plutil", ["-convert", "json", "-o", "-", "--", "-"], { input: plist, encoding: "utf8" }));
    assert.equal(parsed.EnvironmentVariables.IAGENTS_CONFIG, configPath);
    assert.deepEqual(parsed.ProgramArguments, ["/opt/homebrew/bin/node", "/Users/bot/iAgents/src/cli.ts", "run"]);
  });
});
