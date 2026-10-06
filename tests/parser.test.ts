import { deflateRawSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { NeedMoreDataError, NotDicomError, parseDicom, TRANSFER_SYNTAX } from '../src/lib/dicom/parser';
import { readDicomFile } from '../src/lib/dicom/reader';
import type { DicomElement } from '../src/lib/dicom/types';
import { concat, EXPLICIT_BE, EXPLICIT_LE, encodeDataset, IMPLICIT_LE, part10, type El } from './helpers/dicom-writer';

const TS = TRANSFER_SYNTAX;

const find = (elements: DicomElement[], tag: number) => {
  const element = elements.find((e) => e.tag === tag);
  if (!element) throw new Error(`tag ${tag.toString(16)} not found`);
  return element;
};

const basicElements: El[] = [
  { tag: 0x00080016, vr: 'UI', value: '1.2.840.10008.5.1.4.1.1.2' },
  { tag: 0x00080060, vr: 'CS', value: 'CT' },
  { tag: 0x00100010, vr: 'PN', value: 'Doe^John' },
  { tag: 0x00200032, vr: 'DS', value: ['-125.5', '0', '42'] },
  { tag: 0x00280010, vr: 'US', value: [512] },
  { tag: 0x00280030, vr: 'DS', value: ['0.5', '0.5'] },
  { tag: 0x00189306, vr: 'FD', value: [1.25] },
];

describe('parseDicom', () => {
  it('parses an explicit VR little endian file', async () => {
    const file = part10(encodeDataset(basicElements), TS.EXPLICIT_VR_LITTLE_ENDIAN);
    const parsed = await parseDicom(file);

    expect(parsed.hasPreamble).toBe(true);
    expect(parsed.error).toBeUndefined();
    expect(parsed.warnings).toEqual([]);
    expect(parsed.transferSyntax).toMatchObject({ explicitVr: true, littleEndian: true, guessed: false });
    expect(parsed.meta.map((e) => e.tag)).toEqual([0x00020000, 0x00020001, 0x00020002, 0x00020003, 0x00020010]);
    expect(parsed.dataset.map((e) => e.tag)).toEqual(basicElements.map((e) => e.tag));

    expect(find(parsed.dataset, 0x00100010).value).toEqual({ kind: 'text', values: ['Doe^John'] });
    expect(find(parsed.dataset, 0x00200032).value).toEqual({ kind: 'text', values: ['-125.5', '0', '42'] });
    expect(find(parsed.dataset, 0x00280010).value).toEqual({ kind: 'numbers', values: [512], count: 1 });
    expect(find(parsed.dataset, 0x00189306).value).toEqual({ kind: 'numbers', values: [1.25], count: 1 });
    expect(find(parsed.dataset, 0x00080016)).toMatchObject({ vr: 'UI', vrSource: 'explicit' });
  });

  it('records byte offsets of elements and values', async () => {
    const dataset = encodeDataset(basicElements);
    const file = part10(dataset, TS.EXPLICIT_VR_LITTLE_ENDIAN);
    const parsed = await parseDicom(file);
    const datasetStart = file.length - dataset.length;
    const first = parsed.dataset[0];
    expect(first.offset).toBe(datasetStart);
    expect(first.valueOffset).toBe(datasetStart + 8);
    expect(parsed.dataset[1].offset).toBe(first.valueOffset + first.length);
  });

  it('parses implicit VR little endian using the dictionary', async () => {
    const parsed = await parseDicom(part10(encodeDataset(basicElements, IMPLICIT_LE), TS.IMPLICIT_VR_LITTLE_ENDIAN));
    expect(parsed.warnings).toEqual([]);
    const rows = find(parsed.dataset, 0x00280010);
    expect(rows).toMatchObject({ vr: 'US', vrSource: 'implicit', value: { kind: 'numbers', values: [512] } });
    expect(find(parsed.dataset, 0x00100010)).toMatchObject({ vr: 'PN', value: { values: ['Doe^John'] } });
  });

  it('parses explicit VR big endian', async () => {
    const parsed = await parseDicom(part10(encodeDataset(basicElements, EXPLICIT_BE), TS.EXPLICIT_VR_BIG_ENDIAN));
    expect(parsed.transferSyntax.littleEndian).toBe(false);
    expect(find(parsed.dataset, 0x00280010).value).toMatchObject({ values: [512] });
    expect(find(parsed.dataset, 0x00189306).value).toMatchObject({ values: [1.25] });
  });

  it('resolves "US or SS" with the pixel representation in implicit VR', async () => {
    const elements: El[] = [
      { tag: 0x00280103, vr: 'US', value: [1] },
      { tag: 0x00280106, vr: 'SS', value: [-1024] },
    ];
    const parsed = await parseDicom(part10(encodeDataset(elements, IMPLICIT_LE), TS.IMPLICIT_VR_LITTLE_ENDIAN));
    expect(find(parsed.dataset, 0x00280106)).toMatchObject({ vr: 'SS', value: { values: [-1024] } });
  });

  it('keeps duplicate tags and file order', async () => {
    const elements: El[] = [
      { tag: 0x00100020, vr: 'LO', value: 'B' },
      { tag: 0x00100010, vr: 'PN', value: 'A' },
      { tag: 0x00100010, vr: 'PN', value: 'C' },
    ];
    const parsed = await parseDicom(part10(encodeDataset(elements), TS.EXPLICIT_VR_LITTLE_ENDIAN));
    expect(parsed.dataset.map((e) => (e.value.kind === 'text' ? e.value.values[0] : ''))).toEqual(['B', 'A', 'C']);
  });

  describe('sequences', () => {
    const nested: El[] = [
      {
        tag: 0x00081115, // ReferencedSeriesSequence
        vr: 'SQ',
        items: [
          [
            { tag: 0x0020000e, vr: 'UI', value: '1.2.3' },
            {
              tag: 0x0008114a, // ReferencedInstanceSequence
              vr: 'SQ',
              items: [
                [{ tag: 0x00081155, vr: 'UI', value: '1.2.3.1' }],
                [{ tag: 0x00081155, vr: 'UI', value: '1.2.3.2' }],
              ],
            },
          ],
          [],
        ],
      },
      { tag: 0x00400275, vr: 'SQ', items: [] },
      { tag: 0x00100010, vr: 'PN', value: 'After^Sequences' },
    ];

    const check = (dataset: DicomElement[]) => {
      const seq = find(dataset, 0x00081115);
      expect(seq.value.kind).toBe('sequence');
      expect(seq.items).toHaveLength(2);
      expect(seq.items![1].elements).toEqual([]);
      const inner = find(seq.items![0].elements, 0x0008114a);
      expect(inner.items!.map((item) => item.elements[0].value)).toEqual([
        { kind: 'text', values: ['1.2.3.1'] },
        { kind: 'text', values: ['1.2.3.2'] },
      ]);
      expect(find(dataset, 0x00400275).items).toEqual([]);
      expect(find(dataset, 0x00100010).value).toEqual({ kind: 'text', values: ['After^Sequences'] });
    };

    it('parses defined-length nested sequences', async () => {
      const parsed = await parseDicom(part10(encodeDataset(nested), TS.EXPLICIT_VR_LITTLE_ENDIAN));
      expect(parsed.error).toBeUndefined();
      check(parsed.dataset);
    });

    it('parses undefined-length sequences and items', async () => {
      const undefinedLengths = (elements: El[]): El[] =>
        elements.map((el) =>
          el.items
            ? { ...el, undefinedLength: true, undefinedItemLength: true, items: el.items.map(undefinedLengths) }
            : el,
        );
      for (const encoding of [EXPLICIT_LE, IMPLICIT_LE]) {
        const ts = encoding.explicitVr ? TS.EXPLICIT_VR_LITTLE_ENDIAN : TS.IMPLICIT_VR_LITTLE_ENDIAN;
        const parsed = await parseDicom(part10(encodeDataset(undefinedLengths(nested), encoding), ts));
        expect(parsed.error).toBeUndefined();
        check(parsed.dataset);
        expect(find(parsed.dataset, 0x00081115)).toMatchObject({ undefinedLength: true, length: 0xffffffff });
      }
    });

    it('applies a Specific Character Set defined inside an item', async () => {
      const elements: El[] = [
        {
          tag: 0x00081115,
          vr: 'SQ',
          items: [
            [
              { tag: 0x00080005, vr: 'CS', value: 'ISO_IR 192' },
              { tag: 0x00100010, vr: 'PN', value: 'Gérard^Hélène' },
            ],
          ],
        },
      ];
      const parsed = await parseDicom(part10(encodeDataset(elements), TS.EXPLICIT_VR_LITTLE_ENDIAN));
      const item = parsed.dataset[0].items![0];
      expect(find(item.elements, 0x00100010).value).toEqual({ kind: 'text', values: ['Gérard^Hélène'] });
    });
  });

  describe('private tags', () => {
    it('links private elements to their creator', async () => {
      const elements: El[] = [
        { tag: 0x00290010, vr: 'LO', value: 'SIEMENS CSA HEADER' },
        { tag: 0x00290011, vr: 'LO', value: 'OTHER' },
        { tag: 0x00291008, vr: 'CS', value: 'IMAGE NUM 4' },
        { tag: 0x00291108, vr: 'CS', value: 'X' },
        { tag: 0x00293008, vr: 'CS', value: 'ORPHAN' },
      ];
      const parsed = await parseDicom(part10(encodeDataset(elements), TS.EXPLICIT_VR_LITTLE_ENDIAN));
      expect(find(parsed.dataset, 0x00291008).privateCreator).toBe('SIEMENS CSA HEADER');
      expect(find(parsed.dataset, 0x00291108).privateCreator).toBe('OTHER');
      expect(find(parsed.dataset, 0x00293008).privateCreator).toBeUndefined();
    });

    it('parses undefined-length private sequences in implicit VR', async () => {
      const elements: El[] = [
        { tag: 0x00090010, vr: 'LO', value: 'ACME' },
        {
          tag: 0x00091001,
          vr: 'SQ',
          undefinedLength: true,
          undefinedItemLength: true,
          items: [[{ tag: 0x00100010, vr: 'PN', value: 'Nested^Name' }]],
        },
      ];
      const parsed = await parseDicom(part10(encodeDataset(elements, IMPLICIT_LE), TS.IMPLICIT_VR_LITTLE_ENDIAN));
      const seq = find(parsed.dataset, 0x00091001);
      expect(seq).toMatchObject({ vr: 'SQ', privateCreator: 'ACME' });
      expect(seq.items![0].elements[0].value).toEqual({ kind: 'text', values: ['Nested^Name'] });
    });

    it('detects defined-length private sequences in implicit VR', async () => {
      const elements: El[] = [
        { tag: 0x00090010, vr: 'LO', value: 'ACME' },
        { tag: 0x00091001, vr: 'SQ', items: [[{ tag: 0x00100020, vr: 'LO', value: 'ID42' }]] },
      ];
      const parsed = await parseDicom(part10(encodeDataset(elements, IMPLICIT_LE), TS.IMPLICIT_VR_LITTLE_ENDIAN));
      const seq = find(parsed.dataset, 0x00091001);
      expect(seq.vr).toBe('SQ');
      expect(seq.items![0].elements[0].value).toEqual({ kind: 'text', values: ['ID42'] });
    });

    it('parses sequences hidden in explicit UN elements', async () => {
      const inner = encodeDataset([{ tag: 0x00091001, vr: 'SQ', items: [[{ tag: 0x00100020, vr: 'LO', value: 'X' }]] }], IMPLICIT_LE);
      // Strip the implicit header (tag + length) to keep the item bytes only.
      const items = inner.subarray(8);
      const elements: El[] = [
        { tag: 0x00090010, vr: 'LO', value: 'ACME' },
        { tag: 0x00091001, vr: 'UN', value: items },
        { tag: 0x00091002, vr: 'UN', value: new Uint8Array([1, 2, 3, 4]) },
      ];
      const parsed = await parseDicom(part10(encodeDataset(elements), TS.EXPLICIT_VR_LITTLE_ENDIAN));
      expect(find(parsed.dataset, 0x00091001)).toMatchObject({ vr: 'SQ', encodedVr: 'UN' });
      expect(find(parsed.dataset, 0x00091001).items![0].elements[0].value).toEqual({ kind: 'text', values: ['X'] });
      expect(find(parsed.dataset, 0x00091002)).toMatchObject({ vr: 'UN', value: { kind: 'bytes', length: 4 } });
    });

    it('parses undefined-length UN sequences', async () => {
      const elements: El[] = [
        { tag: 0x00090010, vr: 'LO', value: 'ACME' },
        {
          tag: 0x00091001,
          vr: 'UN',
          undefinedLength: true,
          undefinedItemLength: true,
          items: [[{ tag: 0x00100020, vr: 'LO', value: 'Y' }]],
        },
      ];
      const parsed = await parseDicom(part10(encodeDataset(elements), TS.EXPLICIT_VR_LITTLE_ENDIAN));
      expect(find(parsed.dataset, 0x00091001)).toMatchObject({ vr: 'SQ', encodedVr: 'UN' });
      expect(find(parsed.dataset, 0x00091001).items![0].elements[0]).toMatchObject({ vr: 'LO', vrSource: 'implicit' });
    });

    it('decodes standard elements encoded as UN with the dictionary VR', async () => {
      const elements: El[] = [{ tag: 0x00100010, vr: 'UN', value: new TextEncoder().encode('Doe^Jane') }];
      const parsed = await parseDicom(part10(encodeDataset(elements), TS.EXPLICIT_VR_LITTLE_ENDIAN));
      expect(parsed.dataset[0]).toMatchObject({ vr: 'PN', encodedVr: 'UN', value: { values: ['Doe^Jane'] } });
    });
  });

  describe('pixel data', () => {
    const pixels = new Uint8Array(4096);
    const file = part10(
      encodeDataset([
        { tag: 0x00280010, vr: 'US', value: [64] },
        { tag: 0x7fe00010, vr: 'OW', value: pixels },
        { tag: 0xfffcfffc, vr: 'OB', value: new Uint8Array(8) },
      ]),
      TS.EXPLICIT_VR_LITTLE_ENDIAN,
    );
    const pixelDataOffset = file.length - 4096 - 12 - 8 - 12;

    it('stops at the pixel data when only the header is available', async () => {
      const parsed = await parseDicom(file.subarray(0, pixelDataOffset + 20), { complete: false, fileSize: file.length });
      expect(parsed.dataset.map((e) => e.tag)).toEqual([0x00280010, 0x7fe00010]);
      expect(parsed.dataset[1]).toMatchObject({ length: 4096, value: { kind: 'pixel-data', encapsulated: false } });
      expect(parsed.warnings).toEqual(['20 bytes after the Pixel Data were not read']);
    });

    it('asks for more data when the header is incomplete', async () => {
      await expect(parseDicom(file.subarray(0, pixelDataOffset - 3), { complete: false })).rejects.toThrow(NeedMoreDataError);
    });

    it('reads elements after the pixel data when the whole file is available', async () => {
      const parsed = await parseDicom(file);
      expect(parsed.dataset.map((e) => e.tag)).toEqual([0x00280010, 0x7fe00010, 0xfffcfffc]);
    });

    it('counts fragments of encapsulated pixel data', async () => {
      const fragments = concat(
        encodeDataset([{ tag: 0x7fe00010, vr: 'OB', undefinedLength: true, value: new Uint8Array() }]).subarray(0, 12),
        new Uint8Array([0xfe, 0xff, 0x00, 0xe0, 0, 0, 0, 0]), // empty basic offset table
        new Uint8Array([0xfe, 0xff, 0x00, 0xe0, 4, 0, 0, 0, 1, 2, 3, 4]),
        new Uint8Array([0xfe, 0xff, 0x00, 0xe0, 2, 0, 0, 0, 5, 6]),
        new Uint8Array([0xfe, 0xff, 0xdd, 0xe0, 0, 0, 0, 0]),
      );
      const parsed = await parseDicom(part10(fragments, '1.2.840.10008.1.2.4.50'));
      expect(parsed.dataset[0].value).toEqual({ kind: 'pixel-data', encapsulated: true, fragments: 2 });
    });

    it('only reads the header of big files', async () => {
      const big = part10(
        encodeDataset([
          { tag: 0x00100010, vr: 'PN', value: 'Big^File' },
          { tag: 0x7fe00010, vr: 'OW', value: new Uint8Array(8 * 1024 * 1024) },
        ]),
        TS.EXPLICIT_VR_LITTLE_ENDIAN,
      );
      const blob = new Blob([big as Uint8Array<ArrayBuffer>]);
      let bytesRead = 0;
      const spy = {
        size: blob.size,
        slice: (start?: number, end?: number) => {
          const part = blob.slice(start, end);
          bytesRead += part.size;
          return part;
        },
      };
      const parsed = await readDicomFile(spy as Blob);
      expect(parsed.dataset.map((e) => e.tag)).toEqual([0x00100010, 0x7fe00010]);
      expect(bytesRead).toBeLessThanOrEqual(256 * 1024);
    });
  });

  describe('robustness', () => {
    it('keeps what was read when a file is truncated', async () => {
      const file = part10(encodeDataset(basicElements), TS.EXPLICIT_VR_LITTLE_ENDIAN);
      const parsed = await parseDicom(file.subarray(0, file.length - 5));
      expect(parsed.error).toMatch(/truncated/);
      expect(parsed.dataset.map((e) => e.tag)).toEqual(basicElements.map((e) => e.tag));
    });

    it('keeps the items read before a truncation inside a sequence', async () => {
      const elements: El[] = [
        {
          tag: 0x00081115,
          vr: 'SQ',
          items: [[{ tag: 0x0020000e, vr: 'UI', value: '1.2.3' }], [{ tag: 0x0020000e, vr: 'UI', value: '1.2.4.5.6.7' }]],
        },
      ];
      const file = part10(encodeDataset(elements), TS.EXPLICIT_VR_LITTLE_ENDIAN);
      const parsed = await parseDicom(file.subarray(0, file.length - 4));
      expect(parsed.error).toBeDefined();
      expect(parsed.dataset[0].items).toHaveLength(2);
      expect(parsed.dataset[0].items![0].elements[0].value).toEqual({ kind: 'text', values: ['1.2.3'] });
    });

    it('reads raw data sets without preamble and file meta information', async () => {
      for (const encoding of [EXPLICIT_LE, IMPLICIT_LE, EXPLICIT_BE]) {
        const parsed = await parseDicom(encodeDataset(basicElements, encoding));
        expect(parsed.hasPreamble).toBe(false);
        expect(parsed.transferSyntax).toMatchObject({ ...encoding, guessed: true });
        expect(parsed.warnings[0]).toMatch(/No File Meta Information/);
        expect(find(parsed.dataset, 0x00280010).value).toMatchObject({ values: [512] });
      }
    });

    it('detects implicit VR data sets mislabeled as explicit', async () => {
      const parsed = await parseDicom(part10(encodeDataset(basicElements, IMPLICIT_LE), TS.EXPLICIT_VR_LITTLE_ENDIAN));
      expect(parsed.warnings.join()).toMatch(/encoded with implicit VR/);
      expect(find(parsed.dataset, 0x00100010).value).toEqual({ kind: 'text', values: ['Doe^John'] });
    });

    it('rejects files that are not DICOM', async () => {
      const samples = [
        new TextEncoder().encode('Hello, this is a text file and not a DICOM file at all.\n'.repeat(10)),
        new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, ...new Array(200).fill(7)]),
        new TextEncoder().encode('{"00100010": {"vr": "PN"}}'),
        new Uint8Array(1000),
        new Uint8Array(),
      ];
      for (const bytes of samples) await expect(parseDicom(bytes)).rejects.toThrow(NotDicomError);
    });

    it('inflates deflated data sets', async () => {
      const dataset = encodeDataset(basicElements);
      // A trailing padding byte after the deflate stream, as written by some implementations.
      const deflated = concat(deflateRawSync(dataset), new Uint8Array([0]));
      const parsed = await parseDicom(part10(deflated, TS.DEFLATED_EXPLICIT_VR_LITTLE_ENDIAN));
      expect(parsed.error).toBeUndefined();
      expect(parsed.transferSyntax.deflated).toBe(true);
      expect(find(parsed.dataset, 0x00100010).value).toEqual({ kind: 'text', values: ['Doe^John'] });
    });
  });

  describe('character sets', () => {
    const decode = async (charset: string, nameBytes: Uint8Array) => {
      const elements: El[] = [
        { tag: 0x00080005, vr: 'CS', value: charset },
        { tag: 0x00100010, vr: 'PN', value: nameBytes.length % 2 ? concat(nameBytes, new Uint8Array([0x20])) : nameBytes },
      ];
      const parsed = await parseDicom(part10(encodeDataset(elements), TS.EXPLICIT_VR_LITTLE_ENDIAN));
      const value = find(parsed.dataset, 0x00100010).value;
      return value.kind === 'text' ? value.values[0] : undefined;
    };

    it('decodes UTF-8', async () => {
      expect(await decode('ISO_IR 192', new TextEncoder().encode('Gauthier^Émilie'))).toBe('Gauthier^Émilie');
    });

    it('decodes Latin-1', async () => {
      expect(await decode('ISO_IR 100', new Uint8Array([0x42, 0xe9, 0x6c, 0x61, 0x6e, 0x67, 0x65, 0x72]))).toBe('Bélanger');
    });

    it('decodes Japanese with ISO 2022 escape sequences (PS3.5 H.3.1)', async () => {
      const esc = (...b: number[]) => [0x1b, ...b];
      const ascii = (s: string) => [...s].map((c) => c.charCodeAt(0));
      const kanji = (...b: number[]) => [...esc(0x24, 0x42), ...b, ...esc(0x28, 0x42)];
      const bytes = new Uint8Array([
        ...ascii('Yamada^Tarou='),
        ...kanji(0x3b, 0x33, 0x45, 0x44),
        ...ascii('^'),
        ...kanji(0x42, 0x40, 0x4f, 0x3a),
        ...ascii('='),
        ...kanji(0x24, 0x64, 0x24, 0x5e, 0x24, 0x40),
        ...ascii('^'),
        ...kanji(0x24, 0x3f, 0x24, 0x6d, 0x24, 0x26),
      ]);
      expect(await decode('\\ISO 2022 IR 87', bytes)).toBe('Yamada^Tarou=山田^太郎=やまだ^たろう');
    });
  });
});
