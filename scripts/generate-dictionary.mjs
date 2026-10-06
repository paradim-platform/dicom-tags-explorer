#!/usr/bin/env node
// Generates the DICOM data element and UID dictionaries from the official
// DocBook source of the standard (PS3.6 - Data Dictionary).
//
// Usage:
//   node scripts/generate-dictionary.mjs [path/to/part06.xml]
//
// Without an argument, the latest part06.xml is downloaded from dicom.nema.org.

import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const SOURCE_URL = 'https://dicom.nema.org/medical/dicom/current/source/docbook/part06/part06.xml';
const OUT_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '../src/lib/dicom/data');

const ELEMENT_TABLES = [
  'Registry of DICOM Data Elements',
  'Registry of DICOM File Meta Elements',
  'Registry of DICOM Directory Structuring Elements',
  'Registry of DICOM Dynamic RTP Payload Elements',
];
// Table caption -> fixed UID type (null: the type is read from the 4th column).
const UID_TABLES = { 'UID Values': null, 'Well-known Frames of Reference': 'Well-known Frame of Reference' };

async function loadXml() {
  const path = process.argv[2];
  if (path) return readFile(path, 'utf8');
  console.log(`Downloading ${SOURCE_URL} ...`);
  const response = await fetch(SOURCE_URL);
  if (!response.ok) throw new Error(`Download failed: HTTP ${response.status}`);
  return response.text();
}

function decodeEntities(text) {
  return text
    .replace(/&#x([0-9a-f]+);/gi, (_, hex) => String.fromCodePoint(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, dec) => String.fromCodePoint(parseInt(dec, 10)))
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&');
}

function cellText(html) {
  return decodeEntities(html.replace(/<[^>]+>/g, ' '))
    .replace(/[​ ]/g, (c) => (c === ' ' ? ' ' : ''))
    .replace(/\s+/g, ' ')
    .trim();
}

/** Returns the rows (arrays of cell text) of the table with the given caption. */
function tableRows(xml, caption) {
  const captionIndex = xml.indexOf(`<caption>${caption}</caption>`);
  if (captionIndex < 0) throw new Error(`Table not found: ${caption}`);
  const bodyStart = xml.indexOf('<tbody>', captionIndex);
  const bodyEnd = xml.indexOf('</tbody>', bodyStart);
  const body = xml.slice(bodyStart, bodyEnd);
  const rows = [];
  for (const rowMatch of body.matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/g)) {
    const cells = [...rowMatch[1].matchAll(/<td[^>]*>([\s\S]*?)<\/td>|<td[^>]*\/>/g)].map((m) =>
      cellText(m[1] ?? ''),
    );
    rows.push(cells);
  }
  return rows;
}

const xml = await loadXml();
const version = /<subtitle>DICOM PS3\.6 (\S+)/.exec(xml)?.[1] ?? 'unknown';

const elements = {};
for (const caption of ELEMENT_TABLES) {
  for (const [tag, name, keyword, vr, vm, note] of tableRows(xml, caption)) {
    const match = /^\(([0-9A-Fa-fx]{4}),([0-9A-Fa-fx]{4})\)$/.exec(tag ?? '');
    if (!match) continue;
    const key = (match[1] + match[2]).toUpperCase().replace(/X/g, 'x');
    // VRs like "See Note 2" (items, delimiters) carry no usable VR.
    const cleanVr = /^[A-Z]{2}( or [A-Z]{2})*$/.test(vr) ? vr : '';
    const retired = /RET/.test(note ?? '') ? 1 : 0;
    elements[key] = [cleanVr, vm ?? '', keyword ?? '', name ?? '', retired];
  }
}

const uids = {};
for (const [caption, fixedType] of Object.entries(UID_TABLES)) {
  for (const [uid, name, , type] of tableRows(xml, caption)) {
    if (!/^[0-9.]+$/.test(uid ?? '')) continue;
    const retired = /\(Retired\)/i.test(name);
    uids[uid] = [name.replace(/\s*\(Retired\)\s*/i, '').trim(), fixedType ?? type ?? '', retired ? 1 : 0];
  }
}

await mkdir(OUT_DIR, { recursive: true });
const header = { source: `DICOM PS3.6 ${version}`, generated: new Date().toISOString().slice(0, 10) };
await writeFile(resolve(OUT_DIR, 'dictionary.json'), JSON.stringify({ ...header, elements }) + '\n');
await writeFile(resolve(OUT_DIR, 'uids.json'), JSON.stringify({ ...header, uids }) + '\n');

console.log(`DICOM PS3.6 ${version}: ${Object.keys(elements).length} elements, ${Object.keys(uids).length} UIDs`);
console.log(`Written to ${OUT_DIR}`);
