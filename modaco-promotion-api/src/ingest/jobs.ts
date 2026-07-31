import { prisma } from '../db/client';

export async function createJob(fileName: string): Promise<string> {
  const job = await prisma.ingestionJob.create({ data: { fileName } });
  return job.id;
}

export async function setTotalRecords(jobId: string, total: number): Promise<void> {
  await prisma.ingestionJob.update({ where: { id: jobId }, data: { totalRecords: total } });
}

export async function incrementProcessed(
  jobId: string,
  processed: number,
  skipped: number,
): Promise<void> {
  await prisma.ingestionJob.update({
    where: { id: jobId },
    data: { processedRecords: { increment: processed }, skippedRecords: { increment: skipped } },
  });
}

export async function maybeComplete(jobId: string): Promise<void> {
  const job = await prisma.ingestionJob.findUnique({ where: { id: jobId } });
  if (!job || job.status !== 'PROCESSING') {
    return;
  }
  if (job.totalRecords === 0 || job.processedRecords >= job.totalRecords) {
    await prisma.ingestionJob.update({ where: { id: jobId }, data: { status: 'COMPLETED' } });
  }
}

export async function failJob(jobId: string, error: unknown): Promise<void> {
  await prisma.ingestionJob.update({
    where: { id: jobId },
    data: { status: 'FAILED', error: String(error) },
  });
}

export async function getJob(jobId: string) {
  return prisma.ingestionJob.findUnique({ where: { id: jobId } });
}
