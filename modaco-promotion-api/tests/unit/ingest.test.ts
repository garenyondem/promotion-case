import { Readable } from 'node:stream';
import { describe, expect, it } from 'vitest';
import { chunkCsvRows } from '../../src/ingest/chunker';
import { parseRow } from '../../src/ingest/processor';
import { handleRecords } from '../../lambdas/pricing-worker';

function csvStream(content: string): Readable {
  return Readable.from(content);
}

describe('parseRow', () => {
  it('parses a valid row', () => {
    expect(parseRow(['SKU-1', 'Thing', 'Accessories', '100', '10'])).toEqual({
      sku: 'SKU-1',
      name: 'Thing',
      category: 'Accessories',
      basePrice: 100,
      stockQuantity: 10,
    });
  });

  it('rejects a short row', () => {
    expect(parseRow(['a', 'b'])).toBeNull();
  });

  it('rejects an empty basePrice cell', () => {
    expect(parseRow(['SKU-2', 'Thing', 'Accessories', '', '10'])).toBeNull();
  });

  it('rejects an empty stockQuantity cell', () => {
    expect(parseRow(['SKU-3', 'Thing', 'Accessories', '100', ''])).toBeNull();
  });

  it('rejects a negative basePrice', () => {
    expect(parseRow(['SKU-4', 'Thing', 'Accessories', '-1', '10'])).toBeNull();
  });

  it('rejects a non-integer stockQuantity', () => {
    expect(parseRow(['SKU-5', 'Thing', 'Accessories', '100', '1.5'])).toBeNull();
  });

  it('trims whitespace from cells', () => {
    expect(parseRow([' SKU-6 ', ' Thing ', ' Accessories ', ' 10 ', ' 5 '])).toEqual({
      sku: 'SKU-6',
      name: 'Thing',
      category: 'Accessories',
      basePrice: 10,
      stockQuantity: 5,
    });
  });
});

describe('chunkCsvRows', () => {
  it('skips the header row when present', async () => {
    const chunks: string[][][] = [];
    for await (const chunk of chunkCsvRows(
      csvStream('sku,name,category,basePrice,stockQuantity\nA,B,C,1,2\nD,E,F,3,4\n'),
      10,
    )) {
      chunks.push(chunk);
    }
    expect(chunks.flat()).toEqual([
      ['A', 'B', 'C', '1', '2'],
      ['D', 'E', 'F', '3', '4'],
    ]);
  });

  it('keeps the first row when there is no header', async () => {
    const chunks: string[][][] = [];
    for await (const chunk of chunkCsvRows(csvStream('A,B,C,1,2\nD,E,F,3,4\n'), 10)) {
      chunks.push(chunk);
    }
    expect(chunks.flat()).toEqual([
      ['A', 'B', 'C', '1', '2'],
      ['D', 'E', 'F', '3', '4'],
    ]);
  });

  it('yields chunks of the requested size', async () => {
    const lines = ['sku,name,category,basePrice,stockQuantity'];
    for (let i = 0; i < 25; i++) {
      lines.push(`SKU-${i},P,Acc,10,5`);
    }
    const chunks: string[][][] = [];
    for await (const chunk of chunkCsvRows(csvStream(lines.join('\n')), 10)) {
      chunks.push(chunk);
    }
    expect(chunks).toHaveLength(3);
    expect(chunks[0]).toHaveLength(10);
    expect(chunks[1]).toHaveLength(10);
    expect(chunks[2]).toHaveLength(5);
  });
});

describe('pricing-worker handleRecords', () => {
  it('returns batchItemFailures only for failing records', async () => {
    const ok = { messageId: '1', body: 'good' };
    const bad = { messageId: '2', body: 'bad' };
    const results = await handleRecords([ok, bad], async (body) => {
      if (body === 'bad') {
        throw new Error('boom');
      }
    });
    expect(results).toEqual([{ itemIdentifier: '2' }]);
  });

  it('returns no failures when all records succeed', async () => {
    const results = await handleRecords([{ messageId: '1', body: 'x' }], async () => {});
    expect(results).toEqual([]);
  });
});
