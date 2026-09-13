/** Parses JSON that may contain // and /* *\/ comments and trailing commas. */
export function parseJsonc(source: string): unknown {
  return JSON.parse(stripTrailingCommas(stripComments(source)));
}

function stripComments(src: string): string {
  let out = "";
  let i = 0;
  while (i < src.length) {
    if (src[i] === '"') {
      const end = stringEnd(src, i);
      out += src.slice(i, end);
      i = end;
    } else if (src.startsWith("//", i)) {
      while (i < src.length && src[i] !== "\n") i++;
    } else if (src.startsWith("/*", i)) {
      const close = src.indexOf("*/", i + 2);
      i = close === -1 ? src.length : close + 2;
    } else {
      out += src[i];
      i++;
    }
  }
  return out;
}

function stripTrailingCommas(src: string): string {
  let out = "";
  let i = 0;
  while (i < src.length) {
    if (src[i] === '"') {
      const end = stringEnd(src, i);
      out += src.slice(i, end);
      i = end;
      continue;
    }
    if (src[i] === ",") {
      let j = i + 1;
      while (j < src.length && /\s/.test(src[j])) j++;
      if (src[j] === "}" || src[j] === "]") {
        i++;
        continue;
      }
    }
    out += src[i];
    i++;
  }
  return out;
}

/** Index just past the closing quote of the string literal that starts at `start`. */
function stringEnd(src: string, start: number): number {
  let i = start + 1;
  while (i < src.length && src[i] !== '"') i += src[i] === "\\" ? 2 : 1;
  return Math.min(i + 1, src.length);
}
