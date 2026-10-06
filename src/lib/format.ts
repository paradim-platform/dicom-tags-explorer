// Human-readable formatting of element values.

import { formatTag, lookupTag, lookupUid } from './dicom/dictionary';
import type { DicomElement, ElementValue } from './dicom/types';

export function formatBytes(size: number): string {
  if (size < 1024) return `${size} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let value = size / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit++;
  }
  return `${value.toFixed(value < 10 ? 1 : 0)} ${units[unit]}`;
}

function formatNumber(value: number | bigint, vr: string): string {
  if (typeof value === 'bigint') return value.toString();
  // Single precision floats: avoid noise like 0.30000001192092896.
  if (vr === 'FL' || vr === 'OF') return String(Number(value.toPrecision(7)));
  return String(value);
}

export function hexBytes(bytes: Uint8Array, max = bytes.length): string {
  const parts: string[] = [];
  for (let i = 0; i < Math.min(bytes.length, max); i++) parts.push(bytes[i].toString(16).padStart(2, '0'));
  return parts.join(' ');
}

/** Bytes that look like text (printable ASCII, possibly padded): typical of private elements stored as UN. */
export function printableText(bytes: Uint8Array): string | undefined {
  if (bytes.length === 0) return undefined;
  let end = bytes.length;
  while (end > 0 && (bytes[end - 1] === 0 || bytes[end - 1] === 0x20)) end--;
  if (end === 0) return undefined;
  for (let i = 0; i < end; i++) {
    const b = bytes[i];
    if ((b < 0x20 || b > 0x7e) && b !== 0x09 && b !== 0x0a && b !== 0x0d) return undefined;
  }
  return String.fromCharCode(...bytes.subarray(0, end));
}

/** Individual values, as displayed in the details panel. */
export function valueList(element: DicomElement): string[] {
  const value = element.value;
  switch (value.kind) {
    case 'empty':
    case 'sequence':
    case 'pixel-data':
      return [];
    case 'text':
      return value.values;
    case 'numbers':
      return value.values.map((v) => formatNumber(v, element.vr));
    case 'tags':
      return value.values.map(formatTag);
    case 'bytes': {
      const text = element.vr === 'UN' && value.preview.length === value.length ? printableText(value.preview) : undefined;
      return text !== undefined ? text.split('\\') : [];
    }
  }
}

/** One-line summary of a value, as displayed in the tag table. */
export function formatValue(element: DicomElement, maxLength = 512): string {
  const value = element.value;
  let text: string;
  switch (value.kind) {
    case 'empty':
      return '';
    case 'sequence': {
      const count = element.items?.length ?? 0;
      return `${count} item${count === 1 ? '' : 's'}`;
    }
    case 'pixel-data': {
      const fragments = value.fragments !== undefined ? `, ${value.fragments} fragment${value.fragments === 1 ? '' : 's'}` : '';
      const size = element.undefinedLength ? 'encapsulated' : formatBytes(element.length);
      return `${size}${fragments} (not loaded)`;
    }
    case 'numbers':
      text = valueList(element).join('\\');
      if (value.count > value.values.length) text += ` … (${value.count} values)`;
      break;
    case 'bytes': {
      const list = valueList(element);
      if (list.length) {
        text = list.join('\\');
      } else {
        const hex = hexBytes(value.preview, 48);
        text = value.length > 48 ? `${hex} … (${formatBytes(value.length)})` : hex;
      }
      break;
    }
    default:
      text = valueList(element).join('\\');
  }
  text = text.replace(/[\r\n\t]+/g, ' ');
  return text.length > maxLength ? text.slice(0, maxLength) + '…' : text;
}

/** Extra information about a value: UID names, keywords of AT values... */
export function valueAnnotation(element: DicomElement): string | undefined {
  const value: ElementValue = element.value;
  if (element.vr === 'UI' && value.kind === 'text' && value.values.length === 1) {
    const info = lookupUid(value.values[0]);
    if (info) return info.retired ? `${info.name} (retired)` : info.name;
  }
  if (value.kind === 'tags' && value.values.length === 1) {
    return lookupTag(value.values[0])?.keyword || undefined;
  }
  return undefined;
}
