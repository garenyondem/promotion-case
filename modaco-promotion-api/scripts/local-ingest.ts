import { basename } from 'node:path';
import { env } from '../src/config/env';
import { prisma } from '../src/db/client';
import { createJob, getJob } from '../src/ingest/jobs';
import { runLocalPipeline } from '../src/ingest/orchestrator';
import { buildStorage } from '../src/ingest/storage';

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const fileIndex = argv.indexOf('--file');
  const file = fileIndex >= 0 ? argv[fileIndex + 1] : undefined;
  if (!file) {
    console.error('usage: npm run ingest -- --file <path>');
    process.exit(1);
  }
  const storage = buildStorage();
  const jobId = await createJob(basename(file));
  console.log(`job ${jobId} started for ${file}`);
  await runLocalPipeline(jobId, file, env.INGEST_CHUNK_SIZE, env.INGEST_MAX_CONCURRENCY, storage);
  const job = await getJob(jobId);
  console.log(
    `job ${jobId} finished: ${JSON.stringify({
      status: job?.status,
      totalRecords: job?.totalRecords,
      processedRecords: job?.processedRecords,
      skippedRecords: job?.skippedRecords,
    })}`,
  );
  await prisma.$disconnect();
}

void main().catch((error) => {
  console.error(error);
  process.exit(1);
});
