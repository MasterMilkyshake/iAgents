/**
 * Recent macOS versions often leave `message.text` empty and store the body only in
 * `message.attributedBody`, an NSAttributedString archived with NSArchiver ("typedstream").
 * The plain string follows the NSString class entry:
 *
 *   ... "NSString" 01 94 84 01 '+' <length> <utf-8 bytes> ...
 *
 * where <length> is one byte, or 0x81 + uint16 LE, or 0x82 + uint32 LE.
 */
export function decodeAttributedBody(blob: Uint8Array | null | undefined): string | undefined {
  if (!blob || blob.length === 0) return undefined;
  const buf = Buffer.from(blob.buffer, blob.byteOffset, blob.byteLength);
  const marker = buf.indexOf("NSString");
  if (marker === -1) return undefined;

  const plus = buf.indexOf(0x2b, marker + "NSString".length);
  if (plus === -1 || plus - marker > 32) return undefined;

  let i = plus + 1;
  let length = buf[i];
  i += 1;
  if (length === 0x81) {
    if (i + 2 > buf.length) return undefined;
    length = buf.readUInt16LE(i);
    i += 2;
  } else if (length === 0x82) {
    if (i + 4 > buf.length) return undefined;
    length = buf.readUInt32LE(i);
    i += 4;
  }
  if (length === undefined || i + length > buf.length) return undefined;
  return buf.subarray(i, i + length).toString("utf8");
}
