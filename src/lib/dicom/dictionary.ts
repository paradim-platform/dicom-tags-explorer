// Standard data dictionary lookups (tags and UIDs), generated from DICOM PS3.6.
// See scripts/generate-dictionary.mjs.

import dictionaryData from './data/dictionary.json';
import uidData from './data/uids.json';

export const DICTIONARY_SOURCE: string = dictionaryData.source;

export interface TagInfo {
  /** VR from the dictionary; may be ambiguous ("US or SS") or empty (items, delimiters). */
  vr: string;
  vm: string;
  keyword: string;
  name: string;
  retired: boolean;
}

export interface UidInfo {
  name: string;
  type: string;
  retired: boolean;
}

type RawTagEntry = [string, string, string, string, number];
type RawUidEntry = [string, string, number];

const exactTags = new Map<number, TagInfo>();
/** Repeating-group entries such as (60xx,3000), matched with `(tag & mask) === value`. */
const maskedTags: { mask: number; value: number; info: TagInfo }[] = [];

for (const [key, [vr, vm, keyword, name, retired]] of Object.entries(
  dictionaryData.elements as unknown as Record<string, RawTagEntry>,
)) {
  const info: TagInfo = { vr, vm, keyword, name, retired: retired === 1 };
  if (key.includes('x')) {
    let mask = 0;
    let value = 0;
    for (const char of key) {
      mask = mask * 16 + (char === 'x' ? 0 : 0xf);
      value = value * 16 + (char === 'x' ? 0 : parseInt(char, 16));
    }
    maskedTags.push({ mask, value, info });
  } else {
    exactTags.set(parseInt(key, 16), info);
  }
}

const uids = uidData.uids as unknown as Record<string, RawUidEntry>;

export const tagGroup = (tag: number): number => tag >>> 16;
export const tagElement = (tag: number): number => tag & 0xffff;
export const makeTag = (group: number, element: number): number => ((group << 16) | element) >>> 0;

const hex4 = (n: number) => n.toString(16).toUpperCase().padStart(4, '0');

/** "(0010,0010)" */
export function formatTag(tag: number): string {
  return `(${hex4(tagGroup(tag))},${hex4(tagElement(tag))})`;
}

/** "00100010" */
export function tagToHex(tag: number): string {
  return hex4(tagGroup(tag)) + hex4(tagElement(tag));
}

export function isPrivateTag(tag: number): boolean {
  return (tagGroup(tag) & 1) === 1;
}

/** (gggg,0010-00FF) in a private group: reserves a block of private elements for a creator. */
export function isPrivateCreatorTag(tag: number): boolean {
  const element = tagElement(tag);
  return isPrivateTag(tag) && element >= 0x0010 && element <= 0x00ff;
}

/** For a private data element (gggg,xxee), the tag of the private creator element (gggg,00xx) that reserved it. */
export function privateCreatorTagFor(tag: number): number | undefined {
  const element = tagElement(tag);
  if (!isPrivateTag(tag) || element < 0x1000) return undefined;
  return makeTag(tagGroup(tag), element >> 8);
}

const GROUP_LENGTH: TagInfo = { vr: 'UL', vm: '1', keyword: 'GroupLength', name: 'Group Length', retired: false };
const PRIVATE_CREATOR: TagInfo = { vr: 'LO', vm: '1', keyword: 'PrivateCreator', name: 'Private Creator', retired: false };

/** Dictionary entry for a tag, including generic entries for group lengths and private creators. */
export function lookupTag(tag: number): TagInfo | undefined {
  const exact = exactTags.get(tag);
  if (exact) return exact;
  if (tagElement(tag) === 0) return GROUP_LENGTH;
  if (isPrivateCreatorTag(tag)) return PRIVATE_CREATOR;
  if (isPrivateTag(tag)) return undefined;
  for (const entry of maskedTags) {
    if (((tag & entry.mask) >>> 0) === entry.value) return entry.info;
  }
  return undefined;
}

export function lookupUid(uid: string): UidInfo | undefined {
  const entry = uids[uid];
  return entry ? { name: entry[0], type: entry[1], retired: entry[2] === 1 } : undefined;
}
