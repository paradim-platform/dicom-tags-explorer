import { describe, expect, it } from 'vitest';
import { lookupTag, lookupUid } from '../src/lib/dicom/dictionary';
import { parseDicom, TRANSFER_SYNTAX } from '../src/lib/dicom/parser';
import type { DicomElement } from '../src/lib/dicom/types';
import { formatValue, printableText, valueAnnotation } from '../src/lib/format';
import { buildTree, elementPath, filterTree, visibleRows, type ElementNode, type TreeNode } from '../src/lib/tree';
import { encodeDataset, part10, type El } from './helpers/dicom-writer';

const elements: El[] = [
  { tag: 0x00080016, vr: 'UI', value: '1.2.840.10008.5.1.4.1.1.2' },
  { tag: 0x00100010, vr: 'PN', value: 'Doe^John' },
  {
    tag: 0x00081115,
    vr: 'SQ',
    items: [
      [
        { tag: 0x0020000e, vr: 'UI', value: '1.2.3' },
        { tag: 0x0008114a, vr: 'SQ', items: [[{ tag: 0x00081155, vr: 'UI', value: '9.8.7' }]] },
      ],
    ],
  },
  { tag: 0x00090010, vr: 'LO', value: 'ACME' },
  { tag: 0x00091001, vr: 'LO', value: 'secret' },
];

async function tree() {
  return buildTree(await parseDicom(part10(encodeDataset(elements), TRANSFER_SYNTAX.EXPLICIT_VR_LITTLE_ENDIAN)));
}

const label = (node: TreeNode) =>
  node.kind === 'section' ? node.title : node.kind === 'item' ? `Item ${node.index + 1}` : node.keyword;

describe('dictionary', () => {
  it('looks up standard, repeating-group and private tags', () => {
    expect(lookupTag(0x00100010)).toMatchObject({ keyword: 'PatientName', vr: 'PN' });
    expect(lookupTag(0x60023000)).toMatchObject({ keyword: 'OverlayData' });
    expect(lookupTag(0x00290010)).toMatchObject({ keyword: 'PrivateCreator', vr: 'LO' });
    expect(lookupTag(0x00291010)).toBeUndefined();
    expect(lookupTag(0x00100000)).toMatchObject({ keyword: 'GroupLength', vr: 'UL' });
    expect(lookupTag(0x00080001)).toMatchObject({ retired: true });
  });

  it('looks up UIDs', () => {
    expect(lookupUid('1.2.840.10008.1.2.1')).toMatchObject({ name: 'Explicit VR Little Endian', type: 'Transfer Syntax' });
    expect(lookupUid('1.2.840.10008.1.2.2')).toMatchObject({ retired: true });
    expect(lookupUid('1.2.3')).toBeUndefined();
  });
});

describe('buildTree', () => {
  it('builds sections, elements and items', async () => {
    const t = await tree();
    expect(t.sections.map((s) => s.title)).toEqual(['File Meta Information', 'Data Set']);
    const dataset = t.sections[1];
    expect(dataset.children.map(label)).toEqual([
      'SOPClassUID',
      'PatientName',
      'ReferencedSeriesSequence',
      'PrivateCreator',
      '[ACME]',
    ]);
    const sequence = dataset.children[2];
    expect(sequence.children!.map(label)).toEqual(['Item 1']);
    expect(sequence.children![0].children.map(label)).toEqual(['SeriesInstanceUID', 'ReferencedInstanceSequence']);
  });

  it('gives nodes keys based on their tag path', async () => {
    const t = await tree();
    const node = t.byKey.get('dataset/00081115[0]/0008114A[0]/00081155') as ElementNode;
    expect(node.element.value).toEqual({ kind: 'text', values: ['9.8.7'] });
  });

  it('computes element paths', async () => {
    const t = await tree();
    const node = t.byKey.get('dataset/00081115[0]/0008114A[0]/00081155') as ElementNode;
    expect(elementPath(node)).toEqual({
      keywords: 'ReferencedSeriesSequence[0].ReferencedInstanceSequence[0].ReferencedSOPInstanceUID',
      tags: '(0008,1115)[0].(0008,114A)[0].(0008,1155)',
    });
    expect(elementPath(t.byKey.get('dataset/00091001') as ElementNode).keywords).toBe('(0009,1001)');
  });
});

describe('filterTree / visibleRows', () => {
  const expandAll = () => true;
  const collapseElements = (node: TreeNode) => node.kind !== 'element';

  it('shows every row when expanded and only top-level ones when collapsed', async () => {
    const t = await tree();
    const all = visibleRows(t, expandAll, undefined);
    expect(all).toHaveLength(2 + 5 + 5 + 5); // sections + meta + top-level + nested (2 items, 3 elements)
    const collapsed = visibleRows(t, collapseElements, undefined);
    expect(collapsed.map((r) => label(r.node))).not.toContain('SeriesInstanceUID');
    expect(collapsed.find((r) => label(r.node) === 'ReferencedSeriesSequence')).toMatchObject({
      expandable: true,
      expanded: false,
    });
  });

  it('indents nested rows', async () => {
    const t = await tree();
    const rows = visibleRows(t, expandAll, undefined);
    const depth = (name: string) => rows.find((r) => label(r.node) === name)?.depth;
    expect(depth('Data Set')).toBe(0);
    expect(depth('ReferencedSeriesSequence')).toBe(0);
    expect(depth('SeriesInstanceUID')).toBe(2);
    expect(depth('ReferencedSOPInstanceUID')).toBe(4);
  });

  it('matches tags, keywords, names and values', async () => {
    const t = await tree();
    const matches = (query: string) => [...filterTree(t, query)!.matches].map(label);
    expect(matches('patientname')).toEqual(['PatientName']);
    expect(matches("patient's name")).toEqual(['PatientName']);
    expect(matches('0010,0010')).toEqual(['PatientName']);
    expect(matches('00100010')).toEqual(['PatientName']);
    expect(matches('doe')).toEqual(['PatientName']);
    expect(matches('ct image storage')).toEqual(['SOPClassUID']);
    expect(matches('acme')).toEqual(['PrivateCreator', '[ACME]']);
    expect(filterTree(t, '   ')).toBeUndefined();
  });

  it('shows nested matches with their ancestors, even when collapsed', async () => {
    const t = await tree();
    const rows = visibleRows(t, collapseElements, filterTree(t, '9.8.7'));
    expect(rows.map((r) => label(r.node))).toEqual([
      'Data Set',
      'ReferencedSeriesSequence',
      'Item 1',
      'ReferencedInstanceSequence',
      'Item 1',
      'ReferencedSOPInstanceUID',
    ]);
    expect(rows.filter((r) => r.match).map((r) => label(r.node))).toEqual(['ReferencedSOPInstanceUID']);
  });

  it('shows the content of a matching sequence according to the expansion state', async () => {
    const t = await tree();
    const filter = filterTree(t, 'ReferencedSeriesSequence');
    expect(visibleRows(t, collapseElements, filter).map((r) => label(r.node))).toEqual([
      'Data Set',
      'ReferencedSeriesSequence',
    ]);
    expect(visibleRows(t, expandAll, filter).map((r) => label(r.node))).toContain('ReferencedSOPInstanceUID');
  });
});

describe('format', () => {
  const element = (partial: Partial<DicomElement>): DicomElement => ({
    tag: 0x00091001,
    vr: 'UN',
    vrSource: 'explicit',
    length: 0,
    undefinedLength: false,
    offset: 0,
    valueOffset: 0,
    value: { kind: 'empty' },
    ...partial,
  });

  it('formats numbers, with float32 noise removed and truncation', () => {
    expect(formatValue(element({ vr: 'FL', value: { kind: 'numbers', values: [0.30000001192092896], count: 1 } }))).toBe('0.3');
    expect(formatValue(element({ vr: 'US', value: { kind: 'numbers', values: [1, 2], count: 10 } }))).toBe('1\\2 … (10 values)');
  });

  it('shows printable UN values as text, other bytes as hex', () => {
    const text = new TextEncoder().encode('HELLO\\WORLD ');
    expect(formatValue(element({ value: { kind: 'bytes', preview: text, length: text.length, littleEndian: true } }))).toBe(
      'HELLO\\WORLD',
    );
    const binary = new Uint8Array([0, 1, 0xab, 0xff]);
    expect(formatValue(element({ value: { kind: 'bytes', preview: binary, length: 4, littleEndian: true } }))).toBe(
      '00 01 ab ff',
    );
    expect(printableText(new Uint8Array([0x41, 0x00]))).toBe('A');
    expect(printableText(new Uint8Array([0x41, 0x01]))).toBeUndefined();
  });

  it('describes sequences and pixel data', () => {
    expect(formatValue(element({ vr: 'SQ', value: { kind: 'sequence' }, items: [] }))).toBe('0 items');
    expect(
      formatValue(element({ tag: 0x7fe00010, vr: 'OW', length: 2 * 1024 * 1024, value: { kind: 'pixel-data', encapsulated: false } })),
    ).toBe('2.0 MB (not loaded)');
    expect(
      formatValue(
        element({ tag: 0x7fe00010, vr: 'OB', undefinedLength: true, value: { kind: 'pixel-data', encapsulated: true, fragments: 3 } }),
      ),
    ).toBe('encapsulated, 3 fragments (not loaded)');
  });

  it('annotates UIDs and attribute tags', () => {
    expect(valueAnnotation(element({ vr: 'UI', value: { kind: 'text', values: ['1.2.840.10008.1.2'] } }))).toMatch(
      /^Implicit VR Little Endian/,
    );
    expect(valueAnnotation(element({ vr: 'AT', value: { kind: 'tags', values: [0x00100010] } }))).toBe('PatientName');
  });
});
