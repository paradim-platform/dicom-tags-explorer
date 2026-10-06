# DICOM Tags Explorer

A fast, lightweight DICOM tag inspector that runs in the browser. Drop files or folders, and inspect every tag, including nested sequences, without opening 3D Slicer or uploading anything to Orthanc.

**Try it: https://gacou54.github.io/dicom-tags-explorer/**

- **Local only**: files are parsed in the browser. Nothing is uploaded; there is no backend.
- **Instant**: only the header is read (the parser stops at the pixel data), so multi-GB files open immediately.
- **Nested sequences**: a collapsible tree with item numbers, paths (`ReferencedSeriesSequence[0].SeriesInstanceUID`), and private sequences, including those hidden in `UN` elements or in implicit VR files.
- **Filter** by tag (`0010,0010`, `00100010`), keyword, name or value. Nested matches are shown with their parents.
- **Details panel**: every value of the element, VR (explicit or from the dictionary), VM, length, byte offset, private creator, UID names, and a hex dump for binary values.
- **Folders**: browse many files. The selection and expanded sequences are kept when moving to the next file, which makes comparing a tag across a series easy.
- **Robust**: implicit/explicit VR, big endian, deflated, files without preamble or file meta, all character sets (including ISO 2022 Japanese, Korean and Chinese). Truncated or corrupted files show everything read before the error.

## Disclaimer
This project has been in large part generated with Claude Opus 5.5.

## Usage

Drop files or folders anywhere in the window, or use **Open files…** / **Open folder…**.

| Shortcut | Action |
| --- | --- |
| <kbd>↑</kbd> <kbd>↓</kbd> <kbd>PgUp</kbd> <kbd>PgDn</kbd> <kbd>Home</kbd> <kbd>End</kbd> | Move in the tag table |
| <kbd>←</kbd> <kbd>→</kbd>, <kbd>Enter</kbd>, double-click | Collapse / expand |
| <kbd>Ctrl</kbd>+<kbd>F</kbd> or <kbd>/</kbd> | Filter (<kbd>Enter</kbd> jumps to the first match, <kbd>Esc</kbd> clears) |
| <kbd>Ctrl</kbd>+<kbd>C</kbd> | Copy the selected value |
| <kbd>Alt</kbd>+<kbd>↑</kbd> <kbd>↓</kbd> | Previous / next file |
| <kbd>Ctrl</kbd>+<kbd>O</kbd> | Open files |

In the VR column, a dashed border means the VR comes from the dictionary (implicit VR). A dotted underline means the element was encoded as `UN` and decoded with the dictionary VR.

## Development

Requires Node.js ≥ 22.12 (see `.nvmrc`: `nvm use`).

```sh
npm install
npm run dev        # dev server on http://localhost:5173
npm test           # unit tests
npm run check      # type checking (svelte-check)
npm run build      # static build in dist/
```

### Deployment

The public site on GitHub Pages is deployed by `.github/workflows/pages.yml` on every push to `main` (tests, type checking, then build). GitHub Pages cannot send custom headers, so the build also puts the Content Security Policy in a `<meta>` tag of `index.html` (see `vite.config.ts`).

With Docker (nginx, port 8080):

```sh
docker compose up -d --build        # http://localhost:8080
# or
docker build -t dicom-tags-explorer .
docker run -d -p 8080:8080 --restart unless-stopped dicom-tags-explorer
```

The image runs the unit tests during the build, then serves the static site with an unprivileged nginx (non-root, listens on 8080, works with a read-only filesystem). The nginx config (`docker/`) caches the hashed assets forever and revalidates `index.html`, so a redeploy is picked up immediately. It also sends a Content Security Policy with `connect-src 'none'`: the browser itself guarantees that the app cannot send the files anywhere. For HTTPS, put it behind your usual reverse proxy. Mounting it under a sub-path of the proxy (e.g. `/dicom-tags/` → the container's `/`) works because all paths are relative.

Without Docker, `npm run build` produces a static site in `dist/` with relative paths. Serve it from any static web server (GitHub Pages, nginx, next to Orthanc…). It must be served over HTTP(S): browsers block JavaScript modules opened from `file://`.

### Project structure

```
src/
  lib/dicom/          DICOM parsing, no UI and no dependencies
    parser.ts         Read-only parser built for inspection (offsets, partial results, nested/private sequences)
    reader.ts         Reads only the beginning of a File, growing the read until the pixel data is reached
    charset.ts        Specific Character Set decoding, including ISO 2022 code extensions
    values.ts         Value decoding by VR
    dictionary.ts     Tag and UID lookups
    data/*.json       Generated from the DICOM standard (PS3.6)
  lib/tree.ts         Display tree, filtering, flattening into rows
  lib/format.ts       Value formatting
  lib/components/     Svelte components (virtualized tag table, details panel, file list...)
  App.svelte
scripts/
  generate-dictionary.mjs   Regenerates src/lib/dicom/data from the current DICOM standard
  pydicom-dump.py           Dumps how pydicom reads files, for cross-checking the parser
tests/
```

### Updating the DICOM dictionary

```sh
npm run generate:dictionary              # downloads the latest PS3.6 from dicom.nema.org
node scripts/generate-dictionary.mjs part06.xml   # or from a local copy
```

### Cross-checking the parser against pydicom

The unit tests use synthetic files. To compare the parser with pydicom on real files (tags, VRs, offsets, item counts and decoded text):

```sh
python3 scripts/pydicom-dump.py /tmp/corpus path/to/dicom/files...
PYDICOM_CORPUS_DIR=/tmp/corpus npm test
```

All 230 files of pydicom's own test corpus (`pydicom/data/test_files`, `charset_files`, and the downloadable test data) currently match.

## Known limitations / ideas

- No private dictionary: private tags show their creator but no name, and `UN` values are shown as text when printable, or as hex otherwise.
- Read-only: no editing, anonymization or export yet.
- Possible next steps: diff of two files, "which tags vary across this series" view, DICOM JSON export, private dictionary, installable PWA that opens `.dcm` files on double-click.
