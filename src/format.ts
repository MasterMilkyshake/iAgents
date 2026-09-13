/** iMessage shows raw text, so turn common Markdown into something that reads cleanly. */
export function markdownToText(input: string): string {
  let text = input.replace(/\r\n/g, "\n");
  text = text.replace(/```[^\n]*\n([\s\S]*?)```/g, (_m, code: string) => code.replace(/\n$/, ""));
  text = text.replace(/`([^`\n]+)`/g, "$1");
  text = text.replace(/!\[([^\]]*)\]\((\S+?)\)/g, (_m, alt: string, url: string) => (alt ? `${alt}: ${url}` : url));
  text = text.replace(/\[([^\]]+)\]\((\S+?)\)/g, (_m, label: string, url: string) =>
    label === url || url === `mailto:${label}` ? label : `${label} (${url})`,
  );
  // [ \t] rather than \s in line-anchored patterns, so they never swallow the blank lines between paragraphs.
  text = text.replace(/^#{1,6}[ \t]+(.*?)[ \t]*#*[ \t]*$/gm, "$1");
  text = text.replace(/^[ \t]*([-*_])(?:[ \t]*\1){2,}[ \t]*$/gm, "");
  text = text.replace(/(\*\*|__)(?=\S)([\s\S]*?\S)\1/g, "$2");
  text = text.replace(/(^|[\s(])\*(?=\S)([^*\n]*?\S)\*(?=[\s).,!?:;]|$)/gm, "$1$2");
  text = text.replace(/~~(?=\S)([\s\S]*?\S)~~/g, "$1");
  text = text.replace(/^([ \t]*)[-*+][ \t]+/gm, "$1• ");
  text = text.replace(/^[ \t]*>[ \t]?/gm, "");
  text = text.replace(/\n{3,}/g, "\n\n");
  return text.trim();
}

/** Splits long text into bubbles of at most `max` characters, preferring paragraph and sentence breaks. */
export function chunkText(text: string, max: number): string[] {
  if (text.length <= max) return [text];
  const chunks: string[] = [];
  let current = "";
  for (const paragraph of text.split(/\n{2,}/)) {
    for (const piece of splitLong(paragraph, max)) {
      if (current && current.length + 2 + piece.length > max) {
        chunks.push(current);
        current = "";
      }
      current = current ? `${current}\n\n${piece}` : piece;
    }
  }
  if (current.trim()) chunks.push(current);
  return chunks;
}

function splitLong(block: string, max: number): string[] {
  const out: string[] = [];
  let rest = block;
  while (rest.length > max) {
    const window = rest.slice(0, max);
    let cut = Math.max(window.lastIndexOf("\n"), window.lastIndexOf(". ") + 1, window.lastIndexOf(" "));
    if (cut < max / 2) cut = max;
    out.push(rest.slice(0, cut).trimEnd());
    rest = rest.slice(cut).trimStart();
  }
  if (rest) out.push(rest);
  return out;
}

export function truncate(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - 1).trimEnd()}…`;
}
