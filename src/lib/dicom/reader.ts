import { NeedMoreDataError, parseDicom } from './parser';
import type { ParsedDicom } from './types';

/** First read size. Most headers are a few KB; pixel data is never needed. */
const INITIAL_READ_SIZE = 256 * 1024;

/**
 * Reads and parses a DICOM file, loading only as many bytes as needed to reach the pixel data,
 * so that inspecting multi-GB files stays instantaneous.
 */
export async function readDicomFile(file: Blob): Promise<ParsedDicom> {
  let size = Math.min(file.size, INITIAL_READ_SIZE);
  for (;;) {
    const complete = size >= file.size;
    const bytes = new Uint8Array(await file.slice(0, size).arrayBuffer());
    try {
      return await parseDicom(bytes, { complete, fileSize: file.size });
    } catch (error) {
      if (!(error instanceof NeedMoreDataError) || complete) throw error;
      size = error.wholeFile ? file.size : Math.min(file.size, size * 4);
    }
  }
}
