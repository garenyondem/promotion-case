import { S3Client } from '@aws-sdk/client-s3';
import { SQSClient } from '@aws-sdk/client-sqs';
import { env } from '../src/config/env';
import { createJob, setTotalRecords } from '../src/ingest/jobs';
import { orchestrate } from '../src/ingest/orchestrator';
import { SQSQueue } from '../src/ingest/queue';
import { S3Storage } from '../src/ingest/storage';

interface S3Record {
  s3: { bucket: { name: string }; object: { key: string } };
}

export async function handler(event: { Records: S3Record[] }): Promise<void> {
  const storage = new S3Storage(env.INGEST_BUCKET, new S3Client({ region: env.AWS_REGION }));
  const queue = new SQSQueue(new SQSClient({ region: env.AWS_REGION }), env.INGEST_QUEUE_URL ?? '');
  for (const record of event.Records) {
    const jobId = await createJob(record.s3.object.key);
    const totalRows = await orchestrate(
      jobId,
      storage,
      record.s3.object.key,
      queue,
      env.INGEST_CHUNK_SIZE,
    );
    await setTotalRecords(jobId, totalRows);
  }
}
