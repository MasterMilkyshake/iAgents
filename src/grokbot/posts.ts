/** Types and wrapper fields verified in Grok Bot 0.47's transcript card registry and qet/XN renderers.
 * See docs/transcript-shapes.md for provenance. Never interpret arbitrary card content as text.
 */
type Obj = Record<string, unknown>;
type Presentation = { text: string; needsApproval?: boolean; ignoredReason?: string };
const object = (v: unknown): Obj | undefined => v !== null && typeof v === "object" && !Array.isArray(v) ? v as Obj : undefined;
const string = (v: unknown): boolean => typeof v === "string" && v.trim().length > 0;
const ignored = (reason: string): Presentation => ({ text: "", ignoredReason: reason });
const placeholder = (label: string): Presentation => ({ text: `${label} posted. Open Grok Bot to view it.` });

const CARDS: Record<string, { label: string; field?: string; kind?: "string" | "array" }> = {
  attachment: { label: "An attachment", field: "url", kind: "string" },
  widget: { label: "An interactive card", field: "widget" },
  "cursor-agent": { label: "A Cursor agent card", field: "bcId", kind: "string" },
  "secret-request": { label: "A secret request", field: "secretRequest" },
  "credential-request": { label: "A credential request", field: "credentialRequest" },
  "user-form": { label: "A form", field: "formRequest" },
  "email-draft": { label: "An email draft", field: "draft" },
  "slack-draft": { label: "A Slack draft", field: "draft" },
  "permission-request": { label: "A permission request", field: "permission" },
  connector: { label: "A connection card", field: "connector", kind: "string" },
  connectors: { label: "A connections card", field: "connectors", kind: "array" },
  "listener-connect": { label: "A messaging connection card", field: "platform", kind: "string" },
  "scm-connect": { label: "A source control connection card" },
  "team-access": { label: "A team access card" },
  "slack-connect": { label: "A Slack connection card" },
  "bot-template-share": { label: "A shared bot template", field: "shareId", kind: "string" },
};
const APPROVALS = new Set(["auto-review-approval", "cookie-origin-approval", "virtual-card-approval"]);
const EVENTS: Record<string, string> = {
  "name-changed": "A bot name change",
  "channel-connected": "A channel connection",
  "channel-disconnected": "A channel disconnection",
  "automation-changed": "A routine update",
};

/** undefined means ordinary text/role parsing should handle this entry. */
export function presentPost(entry: Obj): Presentation | undefined {
  if (entry.kind === "notice") {
    return string(entry.text) ? placeholder("A notice") : ignored("malformed notice");
  }
  if (entry.kind === "feedback") {
    // opt() renders voted feedback as the user's response and other states as a feedback card.
    return entry.state === "voted" ? { text: "" }
      : string(entry.state) ? placeholder("A feedback card") : ignored("malformed feedback");
  }
  if (entry.kind === "event") {
    const event = object(entry.event);
    const label = event && typeof event.type === "string" && Object.hasOwn(EVENTS, event.type) ? EVENTS[event.type] : undefined;
    return label ? placeholder(label) : ignored("unsupported event type");
  }
  const message = object(entry.message);
  if (!message || typeof message.type !== "string") return undefined;
  const type = message.type;
  if (type === "text") {
    if (!string(message.content) && Array.isArray(message.images) && message.images.length > 0 && message.images.every((image) => string(object(image)?.url))) {
      return placeholder("An image");
    }
    return undefined;
  }
  if (type === "local-tool-permission") return undefined;
  if (APPROVALS.has(type)) {
    const approval = object(message.approval);
    if (!approval || typeof approval.status !== "string") return ignored(`malformed ${type}`);
    if (approval.status !== "pending") return { text: "" };
    return { text: "Waiting for your approval in Grok Bot.", needsApproval: true };
  }
  const card = Object.hasOwn(CARDS, type) ? CARDS[type] : undefined;
  if (!card) return ignored("unsupported message type");
  if (card.field) {
    const value = message[card.field];
    const valid = card.kind === "string" ? string(value)
      : card.kind === "array" ? Array.isArray(value) && value.every(string) : object(value) !== undefined;
    if (!valid) return ignored(`malformed ${type}`);
  }
  return placeholder(card.label);
}
