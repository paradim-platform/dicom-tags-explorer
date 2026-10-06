// Cross-checks the parser against pydicom on a corpus of files.
// Skipped unless PYDICOM_CORPUS_DIR points to the output of scripts/pydicom-dump.py:
//
//   python3 scripts/pydicom-dump.py /tmp/corpus path/to/dicom/files...
//   PYDICOM_CORPUS_DIR=/tmp/corpus npm test

import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { formatTag, isPrivateTag } from '../src/lib/dicom/dictionary';
import { NotDicomError, parseDicom } from '../src/lib/dicom/parser';
import type { DicomElement } from '../src/lib/dicom/types';

interface Expected {
  tag: number;
  vr?: string;
  valueTell?: number;
  length?: number;
  values?: string[];
  items?: Expected[][];
  error?: string;
}

const corpusDir = process.env.PYDICOM_CORPUS_DIR;
const manifest: { path: string; dump: string }[] = corpusDir
  ? JSON.parse(readFileSync(`${corpusDir}/manifest.json`, 'utf8'))
  : [];

/** `skipOffsets`: for deflated files our offsets include the file meta, pydicom's start at the inflated data set. */
function compare(expected: Expected[], actual: DicomElement[], path: string, diffs: string[], skipOffsets = false): void {
  const byTag = new Map<number, DicomElement>();
  for (const element of actual) if (!byTag.has(element.tag)) byTag.set(element.tag, element);

  for (const exp of expected) {
    const where = `${path}${formatTag(exp.tag)}`;
    const act = byTag.get(exp.tag);
    byTag.delete(exp.tag);
    if (!act) {
      diffs.push(`${where}: missing`);
      continue;
    }
    // pydicom keeps private sequences of implicit VR files as UN bytes; we parse them.
    // pydicom also knows VRs of some private tags (private dictionary); we show them as UN.
    const vrOk = exp.vr === act.vr || (exp.vr === 'UN' && act.vr === 'SQ') || (act.vr === 'UN' && isPrivateTag(act.tag));
    if (exp.vr && !vrOk) diffs.push(`${where}: VR ${act.vr}, pydicom ${exp.vr}`);
    // pydicom reports offsets inside defined-length sequences relative to the sequence: compare top-level only.
    if (exp.valueTell !== undefined && !skipOffsets && !path.includes('[') && exp.valueTell !== act.valueOffset) {
      diffs.push(`${where}: value offset ${act.valueOffset}, pydicom ${exp.valueTell}`);
    }
    if (exp.length !== undefined && exp.length !== act.length) {
      diffs.push(`${where}: length ${act.length}, pydicom ${exp.length}`);
    }
    if (exp.values && act.value.kind === 'text') {
      // pydicom drops trailing empty person name component groups ("A^B=" -> "A^B").
      const clean = (v: string) => (act.vr === 'PN' ? v.trim().replace(/[=^]+$/, '') : v.trim());
      const norm = (values: string[]) => JSON.stringify(values.map(clean).filter((v, _, all) => all.length > 1 || v !== ''));
      if (norm(exp.values) !== norm(act.value.values)) {
        diffs.push(`${where}: values ${norm(act.value.values)}, pydicom ${norm(exp.values)}`);
      }
    } else if (exp.values && exp.values.length && act.value.kind !== 'text' && act.vr !== 'UN') {
      diffs.push(`${where}: value kind ${act.value.kind}, pydicom has text ${JSON.stringify(exp.values)}`);
    }
    if (exp.items) {
      const items = act.items ?? [];
      if (items.length !== exp.items.length) {
        diffs.push(`${where}: ${items.length} items, pydicom ${exp.items.length}`);
      }
      exp.items.forEach((item, i) => items[i] && compare(item, items[i].elements, `${where}[${i}].`, diffs));
    }
  }
  for (const extra of byTag.values()) diffs.push(`${path}${formatTag(extra.tag)}: not in pydicom`);
}

describe.skipIf(!corpusDir)('cross-check with pydicom', () => {
  for (const { path, dump } of manifest) {
    it(path.split('/').slice(-2).join('/'), async () => {
      const expected = JSON.parse(readFileSync(dump, 'utf8'));
      const bytes = new Uint8Array(readFileSync(path));
      let parsed;
      try {
        parsed = await parseDicom(bytes);
      } catch (error) {
        if (error instanceof NotDicomError) {
          // pydicom with force=True "reads" anything; only accept this for non-DICOM-looking dumps.
          expect(expected.meta.length, 'pydicom found file meta').toBe(0);
          return;
        }
        throw error;
      }
      const diffs: string[] = [];
      compare(expected.meta, parsed.meta, 'meta:', diffs);
      // pydicom returns an empty data set when the encapsulated pixel data is truncated; we keep the elements.
      const pydicomGaveUp = expected.dataset.length === 0 && parsed.warnings.some((w) => w.includes('Pixel Data'));
      if (!pydicomGaveUp) compare(expected.dataset, parsed.dataset, '', diffs, parsed.transferSyntax.deflated);
      if (process.env.CORPUS_VERBOSE && (diffs.length || parsed.error)) console.log(`@@ ${path}\n  ${[parsed.error ?? "", ...diffs.slice(0, 15)].join("\n  ")}`);
      // Truncated files are reported as errors (pydicom silently accepts them).
      const error = parsed.error?.includes('truncated') ? undefined : parsed.error;
      expect({ diffs: diffs.slice(0, 15), error }).toEqual({ diffs: [], error: undefined });
    });
  }
});
