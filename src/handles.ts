/**
 * iMessage handles show up in several spellings: "+1 (555) 123-4567", "15551234567",
 * "e:bot@icloud.com", "mailto:Bot@iCloud.com". These helpers compare them loosely.
 */

export function normalizeHandle(raw: string | null | undefined): string {
  if (!raw) return "";
  const value = raw.trim().replace(/^(?:e:|p:|tel:|mailto:|imessage:|sms:)/i, "");
  if (value.includes("@")) return value.toLowerCase();
  const digits = value.replace(/[^\d+]/g, "");
  return digits.startsWith("+") ? digits : digits.replace(/\+/g, "");
}

export function handlesMatch(a: string | null | undefined, b: string | null | undefined): boolean {
  const x = normalizeHandle(a);
  const y = normalizeHandle(b);
  if (!x || !y) return false;
  if (x.includes("@") || y.includes("@")) return x === y;
  const dx = x.replace(/\D/g, "");
  const dy = y.replace(/\D/g, "");
  if (dx === dy) return true;
  // Same subscriber number with and without a country code.
  return dx.length >= 10 && dy.length >= 10 && dx.slice(-10) === dy.slice(-10);
}

/** Hides most of a handle for logs: "+1555***67", "jo***@gmail.com". */
export function maskHandle(raw: string): string {
  const value = normalizeHandle(raw);
  if (value.includes("@")) {
    const [user, domain] = value.split("@");
    return `${user.slice(0, 2)}***@${domain}`;
  }
  return value.length > 6 ? `${value.slice(0, 5)}***${value.slice(-2)}` : "***";
}
