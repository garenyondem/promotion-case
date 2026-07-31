import { join } from 'node:path';
import { env } from '../config/env';
import { logger } from '../shared/logger';
import { sleep } from '../shared/async';
import { chunkCsvRows } from './chunker';
import { failJob, getJob, maybeComplete, setTotalRecords } from './jobs';
import { processChunk, type ChunkMessage } from './processor';
import { LocalQueue, type MessageQueue } from './queue';
import type { Storage } from './storage';

export async function orchestrate(
  jobId: string,
  storage: Storage,
  filePath: string,
  queue: MessageQueue,
  chunkSize: number,
): Promise<number> {
  const stream = await storage.openReadStream(filePath);
  let totalRows = 0;
  let buffer: string[] = [];
  for await (const rows of chunkCsvRows(stream, chunkSize)) {
    totalRows += rows.length;
    buffer.push(JSON.stringify({ jobId, rows }));
    if (buffer.length >= 10) {
      await queue.sendMessages(buffer);
      buffer = [];
    }
  }
  if (buffer.length > 0) {
    await queue.sendMessages(buffer);
  }
  return totalRows;
}

export async function runLocalPipeline(
  jobId: string,
  filePath: string,
  chunkSize: number,
  concurrency: number,
  storage: Storage,
): Promise<void> {
  const queue = new LocalQueue(join(env.QUEUE_DIR, jobId));
  const totalRows = await orchestrate(jobId, storage, filePath, queue, chunkSize);
  await setTotalRecords(jobId, totalRows);
  await maybeComplete(jobId);
  if (totalRows === 0) {
    return;
  }
  await drainLocal(queue, concurrency, jobId);
}

async function drainLocal(queue: MessageQueue, concurrency: number, jobId: string): Promise<void> {
  const job = await getJob(jobId);
  const target = job?.totalRecords ?? 0;
  let completed = 0;
  const work = async (): Promise<void> => {
    while (completed < target) {
      const messages = await queue.receiveMessages(1);
      if (messages.length === 0) {
        await sleep(50);
        continue;
      }
      for (const message of messages) {
        try {
          const parsed = JSON.parse(message.body) as ChunkMessage;
          await processChunk(parsed);
          completed += parsed.rows.length;
        } catch (error) {
          logger.error('chunk processing failed', { jobId, error: String(error) });
          await failJob(jobId, error);
          throw error;
        }
        await queue.deleteMessage(message.receiptId);
        await maybeComplete(jobId);
      }
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, concurrency) }, () => work()));
}
