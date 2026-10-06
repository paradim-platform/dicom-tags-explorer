export type ElementValue =
  | { kind: 'empty' }
  | { kind: 'text'; values: string[] }
  /** Binary numbers. `values` may be truncated for very long arrays; `count` is the total number of values. */
  | { kind: 'numbers'; values: (number | bigint)[]; count: number }
  | { kind: 'tags'; values: number[] }
  /** Raw bytes (OB, OW, UN...). `preview` holds the first bytes, `length` is the full value length. */
  | { kind: 'bytes'; preview: Uint8Array; length: number; littleEndian: boolean }
  | { kind: 'sequence' }
  /** Pixel data is never loaded; `fragments` is only known when the whole file was read. */
  | { kind: 'pixel-data'; encapsulated: boolean; fragments?: number };

export interface DicomElement {
  tag: number;
  /** VR used to interpret the value: the explicit VR, or the dictionary VR for implicit VR encodings. */
  vr: string;
  /** Whether the VR was read from the file (explicit) or inferred from the dictionary (implicit). */
  vrSource: 'explicit' | 'implicit';
  /** Set when an explicit `UN` value was decoded using the VR from the dictionary. */
  encodedVr?: string;
  /** Value length as encoded. 0xFFFFFFFF when `undefinedLength`. */
  length: number;
  undefinedLength: boolean;
  /** Byte offset of the element's tag. For deflated files, offsets of data set elements refer to the inflated stream. */
  offset: number;
  /** Byte offset of the element's value. */
  valueOffset: number;
  value: ElementValue;
  /** Items of a sequence (SQ, or UN containing a sequence). */
  items?: DicomItem[];
  /** For private data elements: the value of the private creator element that reserved the block. */
  privateCreator?: string;
}

export interface DicomItem {
  offset: number;
  /** Item length as encoded. 0xFFFFFFFF when `undefinedLength`. */
  length: number;
  undefinedLength: boolean;
  elements: DicomElement[];
}

export interface TransferSyntaxInfo {
  uid: string;
  explicitVr: boolean;
  littleEndian: boolean;
  deflated: boolean;
  /** True when the transfer syntax was not specified in the file and was detected from the data. */
  guessed: boolean;
}

export interface ParsedDicom {
  /** True if the file starts with the 128-byte preamble and the "DICM" prefix. */
  hasPreamble: boolean;
  /** File Meta Information elements (group 0002). */
  meta: DicomElement[];
  /** Main data set elements. */
  dataset: DicomElement[];
  transferSyntax: TransferSyntaxInfo;
  /** Non-fatal problems found while parsing. */
  warnings: string[];
  /** Set when parsing stopped on an error; elements read before the error are kept. */
  error?: string;
}
