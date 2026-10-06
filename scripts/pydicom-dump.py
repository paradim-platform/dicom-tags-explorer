#!/usr/bin/env python3
"""Dumps how pydicom reads DICOM files, to cross-check our parser (tests/pydicom-corpus.test.ts).

Usage:
    python3 scripts/pydicom-dump.py OUTPUT_DIR FILE_OR_DIR [FILE_OR_DIR ...]

Writes OUTPUT_DIR/manifest.json listing {"path", "dump"} pairs, plus one JSON dump per file.
Then run: PYDICOM_CORPUS_DIR=OUTPUT_DIR npm test
"""

import json
import sys
from pathlib import Path

import pydicom
from pydicom.dataelem import RawDataElement
from pydicom.multival import MultiValue
from pydicom.sequence import Sequence

TEXT_VRS = {"AE", "AS", "CS", "DA", "DS", "DT", "IS", "LO", "LT", "PN", "SH", "ST", "TM", "UC", "UI", "UR", "UT"}


def text_values(value):
    if value is None or value == "":
        return []
    items = value if isinstance(value, (MultiValue, list, tuple)) else [value]
    return [str(v) if v is not None else "" for v in items]


def dump_dataset(ds):
    elements = []
    for tag in ds.keys():
        raw = ds.get_item(tag)
        entry = {"tag": int(tag)}
        if isinstance(raw, RawDataElement):
            entry["valueTell"] = raw.value_tell
            entry["length"] = raw.length
        try:
            elem = ds[tag]
        except Exception as exc:  # noqa: BLE001 - we want to record any conversion failure
            entry["error"] = str(exc)
            elements.append(entry)
            continue
        entry["vr"] = elem.VR
        if isinstance(elem.value, Sequence):
            entry["items"] = [dump_dataset(item) for item in elem.value]
        elif elem.VR in TEXT_VRS:
            try:
                entry["values"] = text_values(elem.value)
            except Exception as exc:  # noqa: BLE001
                entry["error"] = str(exc)
        elements.append(entry)
    return elements


def dump_file(path):
    ds = pydicom.dcmread(path, force=True)
    return {
        "meta": dump_dataset(ds.file_meta) if getattr(ds, "file_meta", None) is not None else [],
        "dataset": dump_dataset(ds),
    }


def main():
    out_dir = Path(sys.argv[1])
    out_dir.mkdir(parents=True, exist_ok=True)
    paths = []
    for arg in sys.argv[2:]:
        p = Path(arg)
        paths.extend(sorted(x for x in p.rglob("*") if x.is_file()) if p.is_dir() else [p])

    manifest = []
    for i, path in enumerate(paths):
        try:
            dump = dump_file(path)
        except Exception as exc:  # noqa: BLE001
            print(f"skip {path}: {exc}")
            continue
        dump_path = out_dir / f"{i:04d}_{path.name}.json"
        dump_path.write_text(json.dumps(dump))
        manifest.append({"path": str(path.resolve()), "dump": str(dump_path.resolve())})
    (out_dir / "manifest.json").write_text(json.dumps(manifest, indent=1))
    print(f"{len(manifest)} files dumped to {out_dir}")


if __name__ == "__main__":
    main()
