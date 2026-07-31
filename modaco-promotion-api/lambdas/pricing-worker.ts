import { prisma } from '../src/db/client';
import { maybeComplete } from '../src/ingest/jobs';
import { processChunk, type ChunkMessage } from '../src/ingest/processor';

interface SQSRecord {
  messageId: string;
  body: string;
}

export async function handleRecords(
  records: Array<{ messageId: string; body: string }>,
  process: (body: string) => Promise<void>,
): Promise<Array<{ itemIdentifier: string }>> {
  const batchItemFailures: Array<{ itemIdentifier: string }> = [];
  for (const record of records) {
    try {
      await process(record.body);
    } catch {
      batchItemFailures.push({ itemIdentifier: record.messageId });
    }
  }
  return batchItemFailures;
}

export async function handler(event: {
  Records: SQSRecord[];
}): Promise<{ batchItemFailures: Array<{ itemIdentifier: string }> }> {
  const batchItemFailures = await handleRecords(event.Records, async (body) => {
    const message = JSON.parse(body) as ChunkMessage;
    await processChunk(message);
    await maybeComplete(message.jobId);
  });
  await prisma.$disconnect();
  return { batchItemFailures };
}
