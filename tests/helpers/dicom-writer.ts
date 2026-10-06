// Minimal DICOM writer to build test files.

import { VRS } from '../../src/lib/dicom/vr';

export interface El {
  tag: number;
  vr: string;
  /** Strings are joined with "\" and padded; numbers are encoded according to the VR. */
  value?: string | string[] | number[] | Uint8Array;
  /** Sequence items. */
  items?: El[][];
  undefinedLength?: boolean;
  /** Encode the items with undefined length. */
  undefinedItemLength?: boolean;
}

export interface Encoding {
  explicitVr: boolean;
  littleEndian: boolean;
}

export const EXPLICIT_LE: Encoding = { explicitVr: true, littleEndian: true };
export const IMPLICIT_LE: Encoding = { explicitVr: false, littleEndian: true };
export const EXPLICIT_BE: Encoding = { explicitVr: true, littleEndian: false };

class Bytes {
  private parts: number[] = [];
  u16(v: number, le: boolean) {
    if (le) this.parts.push(v & 0xff, v >> 8);
    else this.parts.push(v >> 8, v & 0xff);
  }
  u32(v: number, le: boolean) {
    const b = [v & 0xff, (v >>> 8) & 0xff, (v >>> 16) & 0xff, v >>> 24];
    this.parts.push(...(le ? b : b.reverse()));
  }
  tag(tag: number, le: boolean) {
    this.u16(tag >>> 16, le);
    this.u16(tag & 0xffff, le);
  }
  raw(bytes: ArrayLike<number>) {
    for (let i = 0; i < bytes.length; i++) this.parts.push(bytes[i]);
  }
  get length() {
    return this.parts.length;
  }
  done() {
    return new Uint8Array(this.parts);
  }
}

function encodeValue(el: El, le: boolean): Uint8Array {
  const { vr, value } = el;
  if (value === undefined) return new Uint8Array();
  if (value instanceof Uint8Array) return value;
  const info = VRS[vr];
  if (info?.kind === 'text' || typeof value === 'string' || typeof value[0] === 'string') {
    const text = Array.isArray(value) ? value.join('\\') : String(value);
    const bytes = [...new TextEncoder().encode(text)];
    if (bytes.length % 2) bytes.push(vr === 'UI' ? 0 : 0x20);
    return new Uint8Array(bytes);
  }
  const numbers = value as number[];
  const size = vr === 'AT' ? 4 : (info?.size ?? 1);
  const view = new DataView(new ArrayBuffer(numbers.length * size));
  numbers.forEach((n, i) => {
    const at = i * size;
    switch (vr) {
      case 'US': case 'OW': view.setUint16(at, n, le); break;
      case 'SS': view.setInt16(at, n, le); break;
      case 'UL': case 'OL': view.setUint32(at, n, le); break;
      case 'SL': view.setInt32(at, n, le); break;
      case 'FL': case 'OF': view.setFloat32(at, n, le); break;
      case 'FD': case 'OD': view.setFloat64(at, n, le); break;
      case 'AT': view.setUint16(at, n >>> 16, le); view.setUint16(at + 2, n & 0xffff, le); break;
      default: view.setUint8(at, n);
    }
  });
  return new Uint8Array(view.buffer);
}

export function encodeDataset(elements: El[], encoding: Encoding = EXPLICIT_LE): Uint8Array {
  const out = new Bytes();
  const le = encoding.littleEndian;
  for (const el of elements) {
    let value: Uint8Array;
    if (el.items) {
      const seq = new Bytes();
      for (const item of el.items) {
        // Items of UN sequences are always implicit VR little endian.
        const itemEncoding = el.vr === 'UN' ? IMPLICIT_LE : encoding;
        const itemBytes = encodeDataset(item, itemEncoding);
        const itemLe = itemEncoding.littleEndian;
        seq.tag(0xfffee000, itemLe);
        seq.u32(el.undefinedItemLength ? 0xffffffff : itemBytes.length, itemLe);
        seq.raw(itemBytes);
        if (el.undefinedItemLength) {
          seq.tag(0xfffee00d, itemLe);
          seq.u32(0, itemLe);
        }
      }
      if (el.undefinedLength) {
        const delimiterLe = el.vr === 'UN' ? true : le;
        seq.tag(0xfffee0dd, delimiterLe);
        seq.u32(0, delimiterLe);
      }
      value = seq.done();
    } else {
      value = encodeValue(el, le);
    }
    const length = el.undefinedLength ? 0xffffffff : value.length;
    out.tag(el.tag, le);
    if (encoding.explicitVr) {
      out.raw([el.vr.charCodeAt(0), el.vr.charCodeAt(1)]);
      if (!VRS[el.vr] || VRS[el.vr].longLength) {
        out.u16(0, le);
        out.u32(length, le);
      } else {
        out.u16(length, le);
      }
    } else {
      out.u32(length, le);
    }
    out.raw(value);
  }
  return out.done();
}

/** A complete Part 10 file: preamble, "DICM", file meta information and data set. */
export function part10(dataset: Uint8Array, transferSyntaxUid: string, extraMeta: El[] = []): Uint8Array {
  const metaElements = encodeDataset(
    [
      { tag: 0x00020001, vr: 'OB', value: new Uint8Array([0, 1]) },
      { tag: 0x00020002, vr: 'UI', value: '1.2.840.10008.5.1.4.1.1.7' },
      { tag: 0x00020003, vr: 'UI', value: '1.2.3.4.5' },
      { tag: 0x00020010, vr: 'UI', value: transferSyntaxUid },
      ...extraMeta,
    ],
    EXPLICIT_LE,
  );
  const groupLength = encodeDataset([{ tag: 0x00020000, vr: 'UL', value: [metaElements.length] }], EXPLICIT_LE);
  const out = new Bytes();
  out.raw(new Uint8Array(128));
  out.raw([0x44, 0x49, 0x43, 0x4d]);
  out.raw(groupLength);
  out.raw(metaElements);
  out.raw(dataset);
  return out.done();
}

export function concat(...parts: Uint8Array[]): Uint8Array {
  const result = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const part of parts) {
    result.set(part, at);
    at += part.length;
  }
  return result;
}
