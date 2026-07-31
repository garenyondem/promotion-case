import { prisma } from '../src/db/client';
import { maybeComplete } from '../src/ingest/jobs';
import { processChunk, type ChunkMessage } from '../src/ingest/processor';

interface SQSRecord {
  body: string;
}

export async function handler(event: { Records: SQSRecord[] }): Promise<void> {
  for (const record of event.Records) {
    const message = JSON.parse(record.body) as ChunkMessage;
    await processChunk(message);
    await maybeComplete(message.jobId);
  }
  await prisma.$disconnect();
}
