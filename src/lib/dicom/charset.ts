// Text decoding according to the Specific Character Set (0008,0005), PS3.3 C.12.1.1.2 and PS3.5 section 6.1.

export interface CharsetDecoder {
  decode(bytes: Uint8Array): string;
  /** Set when the character set is not recognized and a fallback is used. */
  warning?: string;
}

type CodeElement =
  | { kind: 'single'; label: string } // single-byte charset decodable by TextDecoder
  | { kind: 'jisx0208' } // ISO 2022 IR 87 (G0, 2 bytes)
  | { kind: 'jisx0212' } // ISO 2022 IR 159 (G0, 2 bytes)
  | { kind: 'multibyte-g1'; label: string }; // ISO 2022 IR 149 / IR 58 (G1, 2 bytes, high bit set)

const DEFAULT_LABEL = 'windows-1252';

/** Character sets without code extensions. */
const SINGLE_LABELS: Record<string, string> = {
  '': DEFAULT_LABEL,
  'ISO_IR 6': DEFAULT_LABEL,
  'ISO_IR 100': 'iso-8859-1',
  'ISO_IR 101': 'iso-8859-2',
  'ISO_IR 109': 'iso-8859-3',
  'ISO_IR 110': 'iso-8859-4',
  'ISO_IR 144': 'iso-8859-5',
  'ISO_IR 127': 'iso-8859-6',
  'ISO_IR 126': 'iso-8859-7',
  'ISO_IR 138': 'iso-8859-8',
  'ISO_IR 148': 'iso-8859-9',
  'ISO_IR 203': 'iso-8859-15',
  'ISO_IR 166': 'windows-874',
  'ISO_IR 13': 'shift_jis',
  'ISO_IR 192': 'utf-8',
  GB18030: 'gb18030',
  GBK: 'gbk',
};

/** Code elements designated (initially or through escape sequences) by "ISO 2022 IR xxx" terms. */
interface Iso2022Term {
  g0?: CodeElement;
  g1?: CodeElement;
}

const ISO2022_TERMS: Record<string, Iso2022Term> = {
  'ISO 2022 IR 6': { g0: { kind: 'single', label: DEFAULT_LABEL } },
  'ISO 2022 IR 100': { g1: { kind: 'single', label: 'iso-8859-1' } },
  'ISO 2022 IR 101': { g1: { kind: 'single', label: 'iso-8859-2' } },
  'ISO 2022 IR 109': { g1: { kind: 'single', label: 'iso-8859-3' } },
  'ISO 2022 IR 110': { g1: { kind: 'single', label: 'iso-8859-4' } },
  'ISO 2022 IR 144': { g1: { kind: 'single', label: 'iso-8859-5' } },
  'ISO 2022 IR 127': { g1: { kind: 'single', label: 'iso-8859-6' } },
  'ISO 2022 IR 126': { g1: { kind: 'single', label: 'iso-8859-7' } },
  'ISO 2022 IR 138': { g1: { kind: 'single', label: 'iso-8859-8' } },
  'ISO 2022 IR 148': { g1: { kind: 'single', label: 'iso-8859-9' } },
  'ISO 2022 IR 203': { g1: { kind: 'single', label: 'iso-8859-15' } },
  'ISO 2022 IR 166': { g1: { kind: 'single', label: 'windows-874' } },
  // JIS X 0201: Romaji in G0 (treated as ASCII), Katakana in G1.
  'ISO 2022 IR 13': { g0: { kind: 'single', label: DEFAULT_LABEL }, g1: { kind: 'single', label: 'shift_jis' } },
  'ISO 2022 IR 87': { g0: { kind: 'jisx0208' } },
  'ISO 2022 IR 159': { g0: { kind: 'jisx0212' } },
  'ISO 2022 IR 149': { g1: { kind: 'multibyte-g1', label: 'euc-kr' } },
  'ISO 2022 IR 58': { g1: { kind: 'multibyte-g1', label: 'gbk' } },
};

/** Escape sequences (bytes following ESC) and the code element they designate. */
const ESCAPES: [number[], Iso2022Term][] = [
  [[0x28, 0x42], ISO2022_TERMS['ISO 2022 IR 6']], // ESC ( B
  [[0x28, 0x4a], { g0: { kind: 'single', label: DEFAULT_LABEL } }], // ESC ( J  JIS X 0201 Romaji
  [[0x29, 0x49], { g1: { kind: 'single', label: 'shift_jis' } }], // ESC ) I  JIS X 0201 Katakana
  [[0x24, 0x42], ISO2022_TERMS['ISO 2022 IR 87']], // ESC $ B
  [[0x24, 0x28, 0x44], ISO2022_TERMS['ISO 2022 IR 159']], // ESC $ ( D
  [[0x24, 0x29, 0x43], ISO2022_TERMS['ISO 2022 IR 149']], // ESC $ ) C
  [[0x24, 0x29, 0x41], ISO2022_TERMS['ISO 2022 IR 58']], // ESC $ ) A
  [[0x2d, 0x41], ISO2022_TERMS['ISO 2022 IR 100']], // ESC - A
  [[0x2d, 0x42], ISO2022_TERMS['ISO 2022 IR 101']], // ESC - B
  [[0x2d, 0x43], ISO2022_TERMS['ISO 2022 IR 109']], // ESC - C
  [[0x2d, 0x44], ISO2022_TERMS['ISO 2022 IR 110']], // ESC - D
  [[0x2d, 0x4c], ISO2022_TERMS['ISO 2022 IR 144']], // ESC - L
  [[0x2d, 0x47], ISO2022_TERMS['ISO 2022 IR 127']], // ESC - G
  [[0x2d, 0x46], ISO2022_TERMS['ISO 2022 IR 126']], // ESC - F
  [[0x2d, 0x48], ISO2022_TERMS['ISO 2022 IR 138']], // ESC - H
  [[0x2d, 0x4d], ISO2022_TERMS['ISO 2022 IR 148']], // ESC - M
  [[0x2d, 0x62], ISO2022_TERMS['ISO 2022 IR 203']], // ESC - b
  [[0x2d, 0x54], ISO2022_TERMS['ISO 2022 IR 166']], // ESC - T
];

const decoderCache = new Map<string, TextDecoder>();
function textDecoder(label: string): TextDecoder {
  let decoder = decoderCache.get(label);
  if (!decoder) {
    decoder = new TextDecoder(label);
    decoderCache.set(label, decoder);
  }
  return decoder;
}

/** Decodes bytes in the default repertoire (used for VRs not affected by the character set). */
export function decodeDefault(bytes: Uint8Array): string {
  return textDecoder(DEFAULT_LABEL).decode(bytes);
}

function decodeRun(element: CodeElement, bytes: number[]): string {
  switch (element.kind) {
    case 'single':
    case 'multibyte-g1':
      return textDecoder(element.label).decode(new Uint8Array(bytes));
    case 'jisx0208':
      // A fresh decoder each time: Chromium's ISO-2022-JP decoder keeps escape state between decode() calls
      // and would emit U+FFFD at the start of the next run.
      return new TextDecoder('iso-2022-jp').decode(new Uint8Array([0x1b, 0x24, 0x42, ...bytes]));
    case 'jisx0212': {
      // EUC-JP encodes JIS X 0212 as 0x8F followed by the two bytes with the high bit set.
      const euc: number[] = [];
      for (let i = 0; i + 1 < bytes.length; i += 2) euc.push(0x8f, bytes[i] | 0x80, bytes[i + 1] | 0x80);
      return textDecoder('euc-jp').decode(new Uint8Array(euc));
    }
  }
}

const isTwoByteG0 = (element: CodeElement | undefined) => element?.kind === 'jisx0208' || element?.kind === 'jisx0212';

// Characters at which the code element designations return to the initial state (PS3.5 6.1.2.5.3).
const RESET_BYTES = new Set([0x0a, 0x0c, 0x0d, 0x09, 0x5c, 0x3d, 0x5e]);

function createIso2022Decoder(terms: string[]): CharsetDecoder {
  const initial = ISO2022_TERMS[terms[0]] ?? {};
  const initialG0: CodeElement = initial.g0 ?? { kind: 'single', label: DEFAULT_LABEL };
  const initialG1: CodeElement | undefined = initial.g1;

  return {
    decode(bytes: Uint8Array): string {
      let g0 = initialG0;
      let g1 = initialG1;
      let result = '';
      let run: number[] = [];
      let runElement: CodeElement | undefined;

      const flush = () => {
        if (run.length && runElement) result += decodeRun(runElement, run);
        run = [];
      };
      const push = (element: CodeElement, ...values: number[]) => {
        if (element !== runElement) {
          flush();
          runElement = element;
        }
        run.push(...values);
      };

      for (let i = 0; i < bytes.length; i++) {
        const byte = bytes[i];
        if (byte === 0x1b) {
          const escape = ESCAPES.find(([seq]) => seq.every((b, j) => bytes[i + 1 + j] === b));
          if (escape) {
            if (escape[1].g0) g0 = escape[1].g0;
            if (escape[1].g1) g1 = escape[1].g1;
            i += escape[0].length;
            continue;
          }
        }
        if (byte >= 0x80) {
          const element = g1 ?? { kind: 'single', label: DEFAULT_LABEL };
          if (element.kind === 'multibyte-g1' && i + 1 < bytes.length) {
            push(element, byte, bytes[++i]);
          } else {
            push(element, byte);
          }
        } else if (isTwoByteG0(g0) && byte >= 0x21 && byte <= 0x7e && i + 1 < bytes.length) {
          push(g0, byte, bytes[++i]);
        } else {
          if (RESET_BYTES.has(byte) && !isTwoByteG0(g0)) {
            g0 = initialG0;
            g1 = initialG1;
          }
          push(isTwoByteG0(g0) ? initialG0 : g0, byte);
        }
      }
      flush();
      return result;
    },
  };
}

/** Builds a decoder from the values of the Specific Character Set element. */
export function createCharsetDecoder(specificCharacterSet: string[] | undefined): CharsetDecoder {
  const terms = (specificCharacterSet ?? []).map((term) => term.trim());
  if (terms.length === 0) terms.push('');

  const isIso2022 = terms.some((term) => term.startsWith('ISO 2022'));
  if (isIso2022) {
    // A first empty value means the default repertoire (ISO 2022 IR 6) is initially designated.
    if (terms[0] === '') terms[0] = 'ISO 2022 IR 6';
    const unknown = terms.filter((term) => !ISO2022_TERMS[term]);
    const decoder = createIso2022Decoder(terms);
    if (unknown.length) decoder.warning = `Unsupported character set term(s): ${unknown.join(', ')}`;
    return decoder;
  }

  const label = SINGLE_LABELS[terms[0]];
  const decoder: CharsetDecoder = {
    decode: (bytes) => textDecoder(label ?? DEFAULT_LABEL).decode(bytes),
  };
  if (!label) decoder.warning = `Unknown Specific Character Set "${terms[0]}", decoded as Latin-1`;
  else if (terms.length > 1) decoder.warning = `Multiple character sets without ISO 2022 extensions; using "${terms[0]}"`;
  return decoder;
}
