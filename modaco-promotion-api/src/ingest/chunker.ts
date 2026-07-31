import { parse } from 'csv-parse';
import type { Readable } from 'node:stream';

export async function* chunkCsvRows(stream: Readable, chunkSize: number): AsyncGenerator<string[][]> {
  const parser = stream.pipe(parse({ skip_empty_lines: true, relax_column_count: true }));
  let buffer: string[][] = [];
  let first = true;
  for await (const record of parser) {
    if (first) {
      first = false;
      continue;
    }
    buffer.push(record as string[]);
    if (buffer.length >= chunkSize) {
      yield buffer;
      buffer = [];
    }
  }
  if (buffer.length > 0) {
    yield buffer;
  }
}
