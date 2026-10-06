// Collecting files from drag & drop and file inputs, including whole folders.

export interface PickedFile {
  file: File;
  /** Path relative to the dropped/selected folder, or the file name. */
  path: string;
}

function readAllEntries(directory: FileSystemDirectoryEntry): Promise<FileSystemEntry[]> {
  const reader = directory.createReader();
  const entries: FileSystemEntry[] = [];
  return new Promise((resolve, reject) => {
    // readEntries returns results in batches: call it until it returns an empty batch.
    const next = () =>
      reader.readEntries((batch) => {
        if (batch.length === 0) return resolve(entries);
        entries.push(...batch);
        next();
      }, reject);
    next();
  });
}

async function collectEntry(entry: FileSystemEntry, out: PickedFile[]): Promise<void> {
  if (entry.isFile) {
    const file = await new Promise<File>((resolve, reject) => (entry as FileSystemFileEntry).file(resolve, reject));
    out.push({ file, path: entry.fullPath.replace(/^\//, '') });
  } else if (entry.isDirectory) {
    for (const child of await readAllEntries(entry as FileSystemDirectoryEntry)) await collectEntry(child, out);
  }
}

const isHidden = (path: string) => path.split('/').some((part) => part.startsWith('.'));

const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });
export const sortFiles = (files: PickedFile[]) => files.sort((a, b) => collator.compare(a.path, b.path));

/** Files from a drop event. Must be called synchronously in the drop handler (the DataTransfer expires). */
export function filesFromDataTransfer(dataTransfer: DataTransfer): Promise<PickedFile[]> {
  const entries = [...dataTransfer.items]
    .filter((item) => item.kind === 'file')
    .map((item) => item.webkitGetAsEntry?.())
    .filter((entry): entry is FileSystemEntry => !!entry);
  const plainFiles = [...dataTransfer.files];

  return (async () => {
    if (!entries.length) return sortFiles(plainFiles.map((file) => ({ file, path: file.name })));
    const out: PickedFile[] = [];
    for (const entry of entries) await collectEntry(entry, out);
    return sortFiles(out.filter((f) => !isHidden(f.path)));
  })();
}

/** Files from an <input type="file"> (with or without the webkitdirectory attribute). */
export function filesFromInput(list: FileList): PickedFile[] {
  return sortFiles(
    [...list].map((file) => ({ file, path: file.webkitRelativePath || file.name })).filter((f) => !isHidden(f.path)),
  );
}
