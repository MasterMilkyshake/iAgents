// grok-bot-cli ships plain JavaScript; these cover the parts iAgents imports.

declare module "grok-bot-cli/src/gateway.js" {
  export type GatewaySession = {
    gatewayUrl: string;
    gatewayToken: string;
    gatewayHeaders: Record<string, string>;
  };

  export type AgentRecord = {
    id: string;
    name: string;
    title: string;
    description: string;
    isGroup: boolean;
    memberIds: string[];
  };

  export class GatewayError extends Error {
    status?: number;
    method?: string;
  }

  export function connectGateway(): Promise<GatewaySession>;
  export function gatewayCall(session: GatewaySession, method: string, body?: unknown): Promise<unknown>;
  export function listAgents(session: GatewaySession): Promise<AgentRecord[]>;
}

declare module "grok-bot-cli/src/app-session.js" {
  export function inspectGrokBotGatewaySession(): {
    present: boolean;
    usable: boolean;
    code?: string;
    error?: string;
  };
}
