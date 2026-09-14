import assert from "node:assert/strict";
import { it } from "node:test";
import { createGatewayApi } from "../src/grokbot/bridge.ts";

for (const status of [401, 403]) it(`re-reads rotated sessions after ${status}, sharing concurrent reconnects`, async () => {
  let connections = 0;
  const calls: { token: string; body: unknown }[] = [];
  const api = await createGatewayApi({
    async connectGateway() { return { gatewayUrl: "https://example.com", gatewayToken: String(++connections), gatewayHeaders: {} }; },
    async listAgents() { return []; },
    async gatewayCall(session, _method, body) {
      calls.push({ token: session.gatewayToken, body });
      if (session.gatewayToken === "1") throw Object.assign(new Error("expired"), { status });
      return { entries: [] };
    },
  });
  await Promise.all([api.sendPrompt("bot", "test prompt", "stable-nonce"), api.transcriptTail("bot", 50)]);
  assert.equal(connections, 2);
  const prompts = calls.filter((c) => (c.body as { clientNonce?: string }).clientNonce);
  assert.equal(prompts.length, 2);
  assert.deepEqual(prompts[0].body, prompts[1].body);
  api.resetSession!();
  await api.transcriptTail("bot", 1000);
  assert.equal(connections, 3);
});

it("does not reconnect or retry a nonretryable gateway rejection", async () => {
  let connections = 0, calls = 0;
  const api = await createGatewayApi({
    async connectGateway() { connections++; return { gatewayUrl: "https://example.com", gatewayToken: "test", gatewayHeaders: {} }; },
    async listAgents() { return []; },
    async gatewayCall() { calls++; throw Object.assign(new Error("bad request"), { status: 400 }); },
  });
  await assert.rejects(api.transcriptTail("bot", 50));
  assert.equal(connections, 1);
  assert.equal(calls, 1);
});
