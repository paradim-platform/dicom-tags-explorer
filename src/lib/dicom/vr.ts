// Value Representation metadata (DICOM PS3.5 section 6.2).

export interface VrInfo {
  name: string;
  /** Explicit VR encoding uses a 2 reserved bytes + 4-byte length (instead of a 2-byte length). */
  longLength: boolean;
  kind: 'text' | 'number' | 'tag' | 'bytes' | 'sequence';
  /** Size in bytes of one value, for fixed-size binary VRs. */
  size?: number;
  /** Text VR that may hold multiple values separated by a backslash. */
  multiValued?: boolean;
  /** Text VR affected by the Specific Character Set (0008,0005). */
  usesCharset?: boolean;
  /** Leading spaces are significant and must not be trimmed. */
  keepLeadingSpaces?: boolean;
}

export const VRS: Record<string, VrInfo> = {
  AE: { name: 'Application Entity', longLength: false, kind: 'text', multiValued: true },
  AS: { name: 'Age String', longLength: false, kind: 'text', multiValued: true },
  AT: { name: 'Attribute Tag', longLength: false, kind: 'tag', size: 4 },
  CS: { name: 'Code String', longLength: false, kind: 'text', multiValued: true },
  DA: { name: 'Date', longLength: false, kind: 'text', multiValued: true },
  DS: { name: 'Decimal String', longLength: false, kind: 'text', multiValued: true },
  DT: { name: 'Date Time', longLength: false, kind: 'text', multiValued: true },
  FD: { name: 'Floating Point Double', longLength: false, kind: 'number', size: 8 },
  FL: { name: 'Floating Point Single', longLength: false, kind: 'number', size: 4 },
  IS: { name: 'Integer String', longLength: false, kind: 'text', multiValued: true },
  LO: { name: 'Long String', longLength: false, kind: 'text', multiValued: true, usesCharset: true },
  LT: { name: 'Long Text', longLength: false, kind: 'text', usesCharset: true, keepLeadingSpaces: true },
  OB: { name: 'Other Byte', longLength: true, kind: 'bytes', size: 1 },
  OD: { name: 'Other Double', longLength: true, kind: 'bytes', size: 8 },
  OF: { name: 'Other Float', longLength: true, kind: 'bytes', size: 4 },
  OL: { name: 'Other Long', longLength: true, kind: 'bytes', size: 4 },
  OV: { name: 'Other 64-bit Very Long', longLength: true, kind: 'bytes', size: 8 },
  OW: { name: 'Other Word', longLength: true, kind: 'bytes', size: 2 },
  PN: { name: 'Person Name', longLength: false, kind: 'text', multiValued: true, usesCharset: true },
  SH: { name: 'Short String', longLength: false, kind: 'text', multiValued: true, usesCharset: true },
  SL: { name: 'Signed Long', longLength: false, kind: 'number', size: 4 },
  SQ: { name: 'Sequence of Items', longLength: true, kind: 'sequence' },
  SS: { name: 'Signed Short', longLength: false, kind: 'number', size: 2 },
  ST: { name: 'Short Text', longLength: false, kind: 'text', usesCharset: true, keepLeadingSpaces: true },
  SV: { name: 'Signed 64-bit Very Long', longLength: true, kind: 'number', size: 8 },
  TM: { name: 'Time', longLength: false, kind: 'text', multiValued: true },
  UC: { name: 'Unlimited Characters', longLength: true, kind: 'text', multiValued: true, usesCharset: true, keepLeadingSpaces: true },
  UI: { name: 'Unique Identifier', longLength: false, kind: 'text', multiValued: true },
  UL: { name: 'Unsigned Long', longLength: false, kind: 'number', size: 4 },
  UN: { name: 'Unknown', longLength: true, kind: 'bytes', size: 1 },
  UR: { name: 'Universal Resource Identifier', longLength: true, kind: 'text' },
  US: { name: 'Unsigned Short', longLength: false, kind: 'number', size: 2 },
  UT: { name: 'Unlimited Text', longLength: true, kind: 'text', usesCharset: true, keepLeadingSpaces: true },
  UV: { name: 'Unsigned 64-bit Very Long', longLength: true, kind: 'number', size: 8 },
};

export function isKnownVr(vr: string): boolean {
  return Object.hasOwn(VRS, vr);
}

/** Two upper-case ASCII letters: a syntactically valid (possibly future) VR. */
export function looksLikeVr(b0: number, b1: number): boolean {
  return b0 >= 0x41 && b0 <= 0x5a && b1 >= 0x41 && b1 <= 0x5a;
}
