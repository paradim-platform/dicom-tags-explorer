import { decodeDefault, type CharsetDecoder } from './charset';
import { makeTag } from './dictionary';
import type { ElementValue } from './types';
import { VRS } from './vr';

/** Maximum number of binary numbers kept per element (e.g. LUT data can hold thousands). */
export const MAX_NUMBERS = 4096;
/** Number of raw bytes kept for OB/OW/UN... values. */
export const BYTES_PREVIEW = 1024;

function trimText(text: string, keepLeadingSpaces: boolean): string {
  let end = text.length;
  while (end > 0 && (text[end - 1] === ' ' || text[end - 1] === '\0')) end--;
  let start = 0;
  if (!keepLeadingSpaces) while (start < end && text[start] === ' ') start++;
  return text.slice(start, end);
}

/** Decodes the raw bytes of a non-sequence element value. */
export function decodeValue(vr: string, bytes: Uint8Array, littleEndian: boolean, charset: CharsetDecoder): ElementValue {
  if (bytes.length === 0) return { kind: 'empty' };
  const info = VRS[vr];
  const kind = info?.kind ?? 'bytes';

  if (kind === 'text') {
    const text = info.usesCharset ? charset.decode(bytes) : decodeDefault(bytes);
    const parts = info.multiValued ? text.split('\\') : [text];
    return { kind: 'text', values: parts.map((part) => trimText(part, !!info.keepLeadingSpaces)) };
  }

  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);

  if (kind === 'number') {
    const size = info.size!;
    const count = Math.floor(bytes.length / size);
    const values: (number | bigint)[] = [];
    for (let i = 0; i < Math.min(count, MAX_NUMBERS); i++) {
      const at = i * size;
      switch (vr) {
        case 'US': values.push(view.getUint16(at, littleEndian)); break;
        case 'SS': values.push(view.getInt16(at, littleEndian)); break;
        case 'UL': values.push(view.getUint32(at, littleEndian)); break;
        case 'SL': values.push(view.getInt32(at, littleEndian)); break;
        case 'FL': values.push(view.getFloat32(at, littleEndian)); break;
        case 'FD': values.push(view.getFloat64(at, littleEndian)); break;
        case 'SV': values.push(view.getBigInt64(at, littleEndian)); break;
        case 'UV': values.push(view.getBigUint64(at, littleEndian)); break;
      }
    }
    return { kind: 'numbers', values, count };
  }

  if (kind === 'tag') {
    const values: number[] = [];
    for (let at = 0; at + 4 <= bytes.length; at += 4) {
      values.push(makeTag(view.getUint16(at, littleEndian), view.getUint16(at + 2, littleEndian)));
    }
    return { kind: 'tags', values };
  }

  // Copy the preview so that the parsed result does not keep the whole file buffer alive.
  return { kind: 'bytes', preview: bytes.slice(0, BYTES_PREVIEW), length: bytes.length, littleEndian };
}
