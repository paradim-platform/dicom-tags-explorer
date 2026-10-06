// A read-only DICOM parser built for inspection: it keeps every element in file order (including
// duplicates), records byte offsets, parses nested sequences (also private sequences hidden in UN
// elements), never loads pixel data, and keeps everything read so far when the file is corrupted.
//
// References: DICOM PS3.5 (data structures and encoding) and PS3.10 (file format).

import { createCharsetDecoder, type CharsetDecoder } from './charset';
import { formatTag, isPrivateCreatorTag, isPrivateTag, lookupTag, makeTag, privateCreatorTagFor } from './dictionary';
import type { DicomElement, DicomItem, ParsedDicom, TransferSyntaxInfo } from './types';
import { decodeValue } from './values';
import { isKnownVr, looksLikeVr, VRS } from './vr';

/** Thrown when the buffer does not hold the whole file and parsing needs bytes past its end. */
export class NeedMoreDataError extends Error {
  /** @param wholeFile the whole file is needed (e.g. deflated data sets) */
  constructor(readonly wholeFile = false) {
    super('More data is needed to parse this file');
    this.name = 'NeedMoreDataError';
  }
}

/** Thrown when the file does not look like DICOM at all. */
export class NotDicomError extends Error {
  constructor(message = 'Not a DICOM file: no "DICM" prefix and no recognizable data elements') {
    super(message);
    this.name = 'NotDicomError';
  }
}

/** Malformed data; parsing stops but what was read so far is kept. */
class ParseError extends Error {}

export const TRANSFER_SYNTAX = {
  IMPLICIT_VR_LITTLE_ENDIAN: '1.2.840.10008.1.2',
  EXPLICIT_VR_LITTLE_ENDIAN: '1.2.840.10008.1.2.1',
  EXPLICIT_VR_BIG_ENDIAN: '1.2.840.10008.1.2.2',
  DEFLATED_EXPLICIT_VR_LITTLE_ENDIAN: '1.2.840.10008.1.2.1.99',
  JPIP_REFERENCED_DEFLATE: '1.2.840.10008.1.2.4.95',
} as const;

const ITEM = 0xfffee000;
const ITEM_DELIMITER = 0xfffee00d;
const SEQUENCE_DELIMITER = 0xfffee0dd;
const UNDEFINED_LENGTH = 0xffffffff;
const PIXEL_DATA_TAGS = new Set([0x7fe00010, 0x7fe00008, 0x7fe00009]);
const SPECIFIC_CHARACTER_SET = 0x00080005;
const PIXEL_REPRESENTATION = 0x00280103;
const TRANSFER_SYNTAX_UID = 0x00020010;
const MAX_DEPTH = 64;

interface Encoding {
  explicitVr: boolean;
  littleEndian: boolean;
}

/** Sequences encoded as UN always use Implicit VR Little Endian (PS3.5 6.2.2). */
const IMPLICIT_LITTLE: Encoding = { explicitVr: false, littleEndian: true };

export interface ParseOptions {
  /** Whether `bytes` holds the whole file (default true). When false, NeedMoreDataError is thrown if needed. */
  complete?: boolean;
  /** Total size of the file, used to report data after the pixel data that was not read. */
  fileSize?: number;
  /** Raw deflate decompression, for the Deflated Explicit VR Little Endian transfer syntax. */
  inflate?: (data: Uint8Array) => Promise<Uint8Array>;
}

export function transferSyntaxInfo(uid: string, guessed = false): TransferSyntaxInfo {
  switch (uid) {
    case TRANSFER_SYNTAX.IMPLICIT_VR_LITTLE_ENDIAN:
      return { uid, explicitVr: false, littleEndian: true, deflated: false, guessed };
    case TRANSFER_SYNTAX.EXPLICIT_VR_BIG_ENDIAN:
      return { uid, explicitVr: true, littleEndian: false, deflated: false, guessed };
    case TRANSFER_SYNTAX.DEFLATED_EXPLICIT_VR_LITTLE_ENDIAN:
    case TRANSFER_SYNTAX.JPIP_REFERENCED_DEFLATE:
      return { uid, explicitVr: true, littleEndian: true, deflated: true, guessed };
    default:
      // All other transfer syntaxes (including compressed pixel data) use Explicit VR Little Endian.
      return { uid, explicitVr: true, littleEndian: true, deflated: false, guessed };
  }
}

async function inflateRaw(data: Uint8Array): Promise<Uint8Array> {
  // fflate (unlike DecompressionStream) tolerates the padding bytes some writers add after the stream.
  // Loaded on demand: deflated files are rare.
  const { inflateSync } = await import('fflate');
  return inflateSync(data);
}

class Parser {
  private readonly view: DataView;
  private pixelRepresentation = 0;
  /** Set when parsing stopped at the top-level pixel data. */
  stoppedAtPixelData?: DicomElement;

  constructor(
    readonly bytes: Uint8Array,
    readonly complete: boolean,
    readonly warnings: string[],
  ) {
    this.view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  }

  warn(message: string): void {
    if (!this.warnings.includes(message)) this.warnings.push(message);
  }

  /** Makes sure `count` bytes are available at `pos`. */
  private ensure(pos: number, count: number, what: string): void {
    if (pos + count <= this.bytes.length) return;
    if (!this.complete) throw new NeedMoreDataError();
    throw new ParseError(`Unexpected end of file while reading ${what} at offset ${pos} (truncated file?)`);
  }

  u16(pos: number, littleEndian: boolean): number {
    return this.view.getUint16(pos, littleEndian);
  }

  private u32(pos: number, littleEndian: boolean): number {
    return this.view.getUint32(pos, littleEndian);
  }

  private readTag(pos: number, littleEndian: boolean): number {
    return makeTag(this.u16(pos, littleEndian), this.u16(pos + 2, littleEndian));
  }

  /** Guesses the encoding of the data element starting at `pos`. */
  detectEncoding(pos: number): (Encoding & { group: number }) | undefined {
    if (pos + 8 > this.bytes.length) return undefined;
    const little = this.u16(pos, true);
    const big = this.u16(pos, false);
    const littleEndian = little <= big;
    const vr = String.fromCharCode(this.bytes[pos + 4], this.bytes[pos + 5]);
    const explicitVr = looksLikeVr(this.bytes[pos + 4], this.bytes[pos + 5]) && isKnownVr(vr);
    return { explicitVr, littleEndian, group: littleEndian ? little : big };
  }

  /**
   * Whether the bytes at `pos` look like the start of a data set with the given encoding:
   * the first elements must have increasing tags in an even group and lengths that fit in the data.
   */
  looksLikeDataset(pos: number, encoding: Encoding): boolean {
    let previousTag = -1;
    for (let count = 0; count < 4 && pos + 8 <= this.bytes.length; count++) {
      const tag = this.readTag(pos, encoding.littleEndian);
      if (tag <= previousTag) return false;
      if (count === 0 && (tag >>> 16) % 2 === 1) return false;
      previousTag = tag;
      let header = 8;
      let length: number;
      if (encoding.explicitVr) {
        const vr = String.fromCharCode(this.bytes[pos + 4], this.bytes[pos + 5]);
        if (!isKnownVr(vr)) return false;
        if (VRS[vr].longLength) {
          if (pos + 12 > this.bytes.length) return true;
          header = 12;
          length = this.u32(pos + 8, encoding.littleEndian);
        } else {
          length = this.u16(pos + 6, encoding.littleEndian);
        }
      } else {
        length = this.u32(pos + 4, encoding.littleEndian);
      }
      if (length === UNDEFINED_LENGTH) return true;
      pos += header + length;
      if (pos > this.bytes.length) return !this.complete && count > 0;
    }
    return true;
  }

  /** Dictionary VR, resolving ambiguous ones ("US or SS", "OB or OW"...) as well as possible. */
  private dictionaryVr(tag: number, undefinedLength = false): string | undefined {
    const vr = lookupTag(tag)?.vr;
    if (!vr) return undefined;
    if (!vr.includes(' or ')) return vr;
    if (vr.includes('SS')) return this.pixelRepresentation === 1 ? 'SS' : 'US';
    // Encapsulated (undefined length) pixel data is OB; native data in implicit VR is OW.
    if (vr === 'OB or OW') return undefinedLength ? 'OB' : 'OW';
    return vr.split(' or ')[0];
  }

  private readElementHeader(pos: number, encoding: Encoding): DicomElement {
    const { bytes } = this;
    const tag = this.readTag(pos, encoding.littleEndian);
    let explicitVr = encoding.explicitVr;
    if (explicitVr && !looksLikeVr(bytes[pos + 4], bytes[pos + 5])) {
      this.warn('Found implicit VR data elements in an explicit VR data set');
      explicitVr = false;
    }

    if (explicitVr) {
      const vr = String.fromCharCode(bytes[pos + 4], bytes[pos + 5]);
      if (!isKnownVr(vr)) this.warn(`Unknown VR "${vr}" for ${formatTag(tag)}`);
      // Unknown (future) VRs use the long form, like OB (PS3.5 7.1.2).
      if (!isKnownVr(vr) || VRS[vr].longLength) {
        this.ensure(pos, 12, 'data element header');
        const length = this.u32(pos + 8, encoding.littleEndian);
        return this.newElement(tag, vr, 'explicit', length, pos, pos + 12);
      }
      return this.newElement(tag, vr, 'explicit', this.u16(pos + 6, encoding.littleEndian), pos, pos + 8);
    }

    const length = this.u32(pos + 4, encoding.littleEndian);
    return this.newElement(tag, this.dictionaryVr(tag, length === UNDEFINED_LENGTH) ?? 'UN', 'implicit', length, pos, pos + 8);
  }

  private newElement(
    tag: number,
    vr: string,
    vrSource: 'explicit' | 'implicit',
    length: number,
    offset: number,
    valueOffset: number,
  ): DicomElement {
    return {
      tag,
      vr,
      vrSource,
      length,
      undefinedLength: length === UNDEFINED_LENGTH,
      offset,
      valueOffset,
      value: { kind: 'empty' },
    };
  }

  /**
   * Reads data elements into `target`, starting at `pos`, until `end` is reached or, when
   * `untilDelimiter` is set, until an item delimiter. Returns the position after the data set.
   */
  readDataset(
    target: DicomElement[],
    pos: number,
    end: number,
    untilDelimiter: boolean,
    encoding: Encoding,
    depth: number,
    charset: CharsetDecoder,
    metaOnly = false,
  ): number {
    if (depth > MAX_DEPTH) throw new ParseError(`Sequences are nested more than ${MAX_DEPTH} levels deep`);
    const creators = new Map<number, string>();

    while (pos < end) {
      if (metaOnly) {
        if (pos >= this.bytes.length && this.complete) return pos;
        this.ensure(pos, 2, 'file meta information');
        if (this.u16(pos, true) !== 0x0002) return pos;
      }
      this.ensure(pos, 8, 'data element header');
      const tag = this.readTag(pos, encoding.littleEndian);

      if (tag === ITEM_DELIMITER) {
        if (untilDelimiter) return pos + 8;
        this.warn(`Unexpected item delimitation item at offset ${pos}`);
        pos += 8;
        continue;
      }
      if (tag === SEQUENCE_DELIMITER) {
        if (untilDelimiter) {
          // The item delimiter is missing: let the sequence handle its delimiter.
          this.warn(`Missing item delimitation item before offset ${pos}`);
          return pos;
        }
        this.warn(`Unexpected sequence delimitation item at offset ${pos}`);
        pos += 8;
        continue;
      }
      if (tag === ITEM) throw new ParseError(`Unexpected item tag (FFFE,E000) at offset ${pos}`);

      const element = this.readElementHeader(pos, encoding);
      target.push(element);

      if (isPrivateTag(tag)) {
        const creatorTag = privateCreatorTagFor(tag);
        if (creatorTag !== undefined) element.privateCreator = creators.get(creatorTag);
      }

      const isPixelData = PIXEL_DATA_TAGS.has(tag);
      if (isPixelData && depth === 0) {
        element.value = { kind: 'pixel-data', encapsulated: element.undefinedLength };
        if (!this.complete) {
          this.stoppedAtPixelData = element;
          return pos;
        }
        if (element.undefinedLength) {
          try {
            pos = this.readFragments(element, encoding);
          } catch (error) {
            if (!(error instanceof ParseError)) throw error;
            this.warn(`Encapsulated Pixel Data is truncated or malformed: ${error.message}`);
            return this.bytes.length;
          }
          continue;
        }
        const valueEnd = element.valueOffset + element.length;
        if (valueEnd > this.bytes.length) {
          this.warn(`Pixel Data extends past the end of the file (truncated file?)`);
          return this.bytes.length;
        }
        pos = valueEnd;
        continue;
      }

      if (!element.undefinedLength) {
        const valueEnd = element.valueOffset + element.length;
        if (valueEnd > this.bytes.length) {
          if (!this.complete) throw new NeedMoreDataError();
          // For a truncated sequence, read the items that are there: the error is reported where the data ends.
          if (element.vr !== 'SQ') {
            // Keep the partial value: it often helps understanding what went wrong.
            element.value = decodeValue(element.vr, this.bytes.subarray(element.valueOffset), encoding.littleEndian, charset);
            throw new ParseError(
              `${formatTag(tag)} at offset ${pos}: value length ${element.length} extends past the end of the file (truncated file?)`,
            );
          }
        } else if (valueEnd > end) {
          throw new ParseError(
            `${formatTag(tag)} at offset ${pos}: value length ${element.length} exceeds the end of its item (offset ${end})`,
          );
        }
      }

      pos = this.readValue(element, encoding, depth, charset);

      if (tag === SPECIFIC_CHARACTER_SET) {
        charset = createCharsetDecoder(element.value.kind === 'text' ? element.value.values : undefined);
        if (charset.warning) this.warn(charset.warning);
      } else if (tag === PIXEL_REPRESENTATION && element.value.kind === 'numbers') {
        this.pixelRepresentation = Number(element.value.values[0]);
      } else if (isPrivateCreatorTag(tag) && element.value.kind === 'text') {
        creators.set(tag, element.value.values[0]);
      }
    }

    if (untilDelimiter) throw new ParseError('Missing item delimitation item at the end of an item');
    return pos;
  }

  /** Reads the value of a (non top-level pixel data) element and returns the position after it. */
  private readValue(element: DicomElement, encoding: Encoding, depth: number, charset: CharsetDecoder): number {
    const { tag, vr } = element;

    if (PIXEL_DATA_TAGS.has(tag)) {
      // Pixel data nested in a sequence, e.g. in the Icon Image Sequence.
      element.value = { kind: 'pixel-data', encapsulated: element.undefinedLength };
      if (element.undefinedLength) return this.readFragments(element, encoding);
      return element.valueOffset + element.length;
    }

    if (vr === 'SQ') return this.readSequence(element, encoding, depth, charset);

    if (element.undefinedLength) {
      if (vr === 'UN') {
        // Undefined length UN: a sequence encoded in Implicit VR Little Endian.
        if (element.vrSource === 'explicit') element.encodedVr = 'UN';
        element.vr = 'SQ';
        return this.readSequence(element, IMPLICIT_LITTLE, depth, charset);
      }
      if ((vr === 'OB' || vr === 'OW') && this.peekTag(element.valueOffset, encoding) === ITEM) {
        return this.readFragments(element, encoding);
      }
      this.warn(`${formatTag(tag)} has an undefined length but VR ${vr}; parsed as a sequence`);
      return this.readSequence(element, encoding, depth, charset);
    }

    const valueEnd = element.valueOffset + element.length;
    if (vr === 'UN') {
      const dictionaryVr = this.dictionaryVr(tag);
      if (dictionaryVr === 'SQ' || (dictionaryVr === undefined && this.startsWithItem(element))) {
        if (this.tryReadUnSequence(element, depth, charset)) return valueEnd;
      } else if (dictionaryVr && dictionaryVr !== 'UN') {
        // A standard element encoded as UN (e.g. after going through a system that did not know it).
        element.encodedVr = 'UN';
        element.vr = dictionaryVr;
      }
    }

    element.value = decodeValue(
      element.vr,
      this.bytes.subarray(element.valueOffset, valueEnd),
      encoding.littleEndian,
      charset,
    );
    return valueEnd;
  }

  private peekTag(pos: number, encoding: Encoding): number | undefined {
    if (pos + 4 > this.bytes.length) return undefined;
    return this.readTag(pos, encoding.littleEndian);
  }

  private startsWithItem(element: DicomElement): boolean {
    return element.length >= 8 && this.peekTag(element.valueOffset, IMPLICIT_LITTLE) === ITEM;
  }

  /** Tries to read a defined-length UN value as an implicit VR little endian sequence. */
  private tryReadUnSequence(element: DicomElement, depth: number, charset: CharsetDecoder): boolean {
    const probe: DicomElement = { ...element };
    const warningCount = this.warnings.length;
    try {
      this.readSequence(probe, IMPLICIT_LITTLE, depth, charset);
    } catch (error) {
      if (!(error instanceof ParseError || error instanceof NeedMoreDataError || error instanceof RangeError)) throw error;
      this.warnings.length = warningCount;
      return false;
    }
    if (element.vrSource === 'explicit') element.encodedVr = 'UN';
    element.vr = 'SQ';
    element.items = probe.items;
    element.value = probe.value;
    return true;
  }

  private readSequence(element: DicomElement, encoding: Encoding, depth: number, charset: CharsetDecoder): number {
    const items: DicomItem[] = [];
    element.items = items;
    element.value = { kind: 'sequence' };
    const end = element.undefinedLength ? undefined : element.valueOffset + element.length;
    let pos = element.valueOffset;

    while (end === undefined || pos < end) {
      this.ensure(pos, 8, `item of ${formatTag(element.tag)}`);
      const tag = this.readTag(pos, encoding.littleEndian);
      const length = this.u32(pos + 4, encoding.littleEndian);

      if (tag === SEQUENCE_DELIMITER) {
        pos += 8;
        if (end === undefined) return pos;
        this.warn(`Unexpected sequence delimiter in defined-length sequence ${formatTag(element.tag)}`);
        continue;
      }
      if (tag !== ITEM) {
        throw new ParseError(
          `Expected an item (FFFE,E000) in sequence ${formatTag(element.tag)} at offset ${pos}, found ${formatTag(tag)}`,
        );
      }

      const item: DicomItem = { offset: pos, length, undefinedLength: length === UNDEFINED_LENGTH, elements: [] };
      items.push(item);
      pos += 8;
      if (item.undefinedLength) {
        pos = this.readDataset(item.elements, pos, Infinity, true, encoding, depth + 1, charset);
      } else {
        let itemEnd = pos + length;
        if (end !== undefined && itemEnd > end) {
          this.warn(`Item at offset ${item.offset} exceeds the end of sequence ${formatTag(element.tag)}`);
          itemEnd = end;
        }
        this.readDataset(item.elements, pos, itemEnd, false, encoding, depth + 1, charset);
        pos = itemEnd;
      }
    }
    return pos;
  }

  /** Skips encapsulated data (Basic Offset Table + fragments) and records the number of fragments. */
  private readFragments(element: DicomElement, encoding: Encoding): number {
    let pos = element.valueOffset;
    let items = 0;
    for (;;) {
      this.ensure(pos, 8, `encapsulated data of ${formatTag(element.tag)}`);
      const tag = this.readTag(pos, encoding.littleEndian);
      const length = this.u32(pos + 4, encoding.littleEndian);
      pos += 8;
      if (tag === SEQUENCE_DELIMITER) break;
      if (tag !== ITEM) {
        throw new ParseError(`Expected a fragment item in ${formatTag(element.tag)} at offset ${pos - 8}, found ${formatTag(tag)}`);
      }
      pos += length;
      items++;
    }
    if (element.value.kind === 'pixel-data') {
      // The first item is the Basic Offset Table.
      element.value.fragments = Math.max(items - 1, 0);
    } else {
      element.value = { kind: 'pixel-data', encapsulated: true, fragments: Math.max(items - 1, 0) };
    }
    return pos;
  }
}

function hasDicmPrefix(bytes: Uint8Array, pos: number): boolean {
  return (
    bytes.length >= pos + 4 &&
    bytes[pos] === 0x44 &&
    bytes[pos + 1] === 0x49 &&
    bytes[pos + 2] === 0x43 &&
    bytes[pos + 3] === 0x4d
  );
}

/**
 * Parses a DICOM file (or a raw data set without File Meta Information).
 *
 * Throws NotDicomError when the data is clearly not DICOM, and NeedMoreDataError when
 * `options.complete` is false and the buffer is too short. Any other problem is reported
 * through `error` / `warnings` with the elements read so far.
 */
export async function parseDicom(bytes: Uint8Array, options: ParseOptions = {}): Promise<ParsedDicom> {
  const complete = options.complete ?? true;
  const warnings: string[] = [];
  let parser = new Parser(bytes, complete, warnings);
  const result: ParsedDicom = {
    hasPreamble: false,
    meta: [],
    dataset: [],
    transferSyntax: transferSyntaxInfo(TRANSFER_SYNTAX.EXPLICIT_VR_LITTLE_ENDIAN),
    warnings,
  };
  const defaultCharset = createCharsetDecoder(undefined);

  try {
    let pos = 0;
    if (hasDicmPrefix(bytes, 128)) {
      result.hasPreamble = true;
      pos = 132;
    } else if (hasDicmPrefix(bytes, 0)) {
      parser.warn('The 128-byte preamble is missing (file starts with "DICM")');
      pos = 4;
    }

    // File Meta Information (always Explicit VR Little Endian).
    if (pos + 8 <= bytes.length && parser.u16(pos, true) === 0x0002) {
      if (!result.hasPreamble && pos === 0) parser.warn('The 128-byte preamble and "DICM" prefix are missing');
      const metaEncoding = parser.detectEncoding(pos);
      if (metaEncoding && !metaEncoding.explicitVr) parser.warn('File Meta Information is not encoded in explicit VR');
      pos = parser.readDataset(
        result.meta,
        pos,
        complete ? bytes.length : Infinity,
        false,
        { explicitVr: metaEncoding?.explicitVr ?? true, littleEndian: true },
        0,
        defaultCharset,
        true,
      );
    } else if (result.hasPreamble) {
      parser.warn('File Meta Information is missing');
    }

    const tsElement = result.meta.find((element) => element.tag === TRANSFER_SYNTAX_UID);
    const tsUid = tsElement?.value.kind === 'text' ? tsElement.value.values[0] : undefined;
    const isRawDataset = result.meta.length === 0 && pos === 0;

    if (tsUid) {
      result.transferSyntax = transferSyntaxInfo(tsUid);
      if (result.transferSyntax.deflated) {
        if (!complete) throw new NeedMoreDataError(true);
        let inflated: Uint8Array;
        try {
          inflated = await (options.inflate ?? inflateRaw)(bytes.subarray(pos));
        } catch (error) {
          throw new ParseError(`Could not inflate the deflated data set: ${(error as Error).message}`);
        }
        const combined = new Uint8Array(pos + inflated.length);
        combined.set(bytes.subarray(0, pos));
        combined.set(inflated, pos);
        bytes = combined;
        parser = new Parser(bytes, true, warnings);
      }
    }

    if (pos >= bytes.length) {
      if (!complete) throw new NeedMoreDataError();
      if (!isRawDataset) return result;
    }

    const detected = parser.detectEncoding(pos);
    if (isRawDataset) {
      const plausible =
        detected !== undefined &&
        detected.group >= 0x0002 &&
        detected.group <= 0x0010 &&
        parser.looksLikeDataset(pos, detected);
      if (!plausible) throw new NotDicomError();
    }

    const encoding: Encoding = {
      explicitVr: result.transferSyntax.explicitVr,
      littleEndian: result.transferSyntax.littleEndian,
    };
    if (!tsUid && detected) {
      const uid = detected.explicitVr
        ? detected.littleEndian
          ? TRANSFER_SYNTAX.EXPLICIT_VR_LITTLE_ENDIAN
          : TRANSFER_SYNTAX.EXPLICIT_VR_BIG_ENDIAN
        : TRANSFER_SYNTAX.IMPLICIT_VR_LITTLE_ENDIAN;
      result.transferSyntax = transferSyntaxInfo(uid, true);
      encoding.explicitVr = detected.explicitVr;
      encoding.littleEndian = detected.littleEndian;
      parser.warn(
        isRawDataset
          ? 'No File Meta Information: the transfer syntax was detected from the data'
          : 'No Transfer Syntax UID in the File Meta Information: the transfer syntax was detected from the data',
      );
    } else if (detected && detected.explicitVr !== encoding.explicitVr) {
      parser.warn(
        `The transfer syntax specifies ${encoding.explicitVr ? 'explicit' : 'implicit'} VR, ` +
          `but the data set is encoded with ${detected.explicitVr ? 'explicit' : 'implicit'} VR`,
      );
      encoding.explicitVr = detected.explicitVr;
    }

    parser.readDataset(result.dataset, pos, complete ? bytes.length : Infinity, false, encoding, 0, defaultCharset);

    const pixelData = parser.stoppedAtPixelData;
    if (pixelData && !pixelData.undefinedLength && options.fileSize !== undefined) {
      const remaining = options.fileSize - (pixelData.valueOffset + pixelData.length);
      if (remaining > 0) parser.warn(`${remaining} bytes after the Pixel Data were not read`);
    }
  } catch (error) {
    if (error instanceof NeedMoreDataError || error instanceof NotDicomError) throw error;
    if (error instanceof ParseError || error instanceof RangeError) {
      result.error = error.message;
    } else {
      throw error;
    }
  }
  return result;
}
