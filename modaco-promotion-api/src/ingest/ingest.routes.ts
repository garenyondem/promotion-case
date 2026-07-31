import { Router, type Request } from 'express';
import busboy from 'busboy';
import type { Readable } from 'node:stream';
import type { AppContext } from '../app-context';
import { env } from '../config/env';
import { AppError } from '../shared/errors';
import { logger } from '../shared/logger';
import { createJob, getJob } from './jobs';
import { runLocalPipeline } from './orchestrator';
import type { Storage } from './storage';

function saveUpload(req: Request, storage: Storage): Promise<{ filename: string; path: string; size: number }> {
  return new Promise((resolve, reject) => {
    const bb = busboy({ headers: req.headers });
    let result: { filename: string; path: string; size: number } | undefined;
    const writes: Promise<void>[] = [];
    bb.on('file', (_name, file: Readable, info) => {
      writes.push(
        storage.saveFile(info.filename, file).then((saved) => {
          result = { filename: info.filename, ...saved };
        }),
      );
    });
    bb.on('close', () => {
      Promise.all(writes)
        .then(() => {
          if (result) {
            resolve(result);
          } else {
            reject(new AppError(400, 'VALIDATION_ERROR', 'No file received'));
          }
        })
        .catch(reject);
    });
    bb.on('error', reject);
    req.pipe(bb);
  });
}

export function ingestRoutes(ctx: AppContext): Router {
  const router = Router();

  router.post('/ingest', async (req, res, next) => {
    try {
      const saved = await saveUpload(req, ctx.storage);
      const jobId = await createJob(saved.filename);
      void runLocalPipeline(jobId, saved.path, env.INGEST_CHUNK_SIZE, env.INGEST_MAX_CONCURRENCY, ctx.storage).catch(
        (error) => {
          logger.error('ingestion pipeline failed', { jobId, error: String(error) });
        },
      );
      res.status(202).json({ jobId, status: 'PROCESSING' });
    } catch (error) {
      next(error);
    }
  });

  router.get('/ingest/:id', async (req, res, next) => {
    try {
      const job = await getJob(req.params.id);
      if (!job) {
        throw new AppError(404, 'NOT_FOUND', 'Ingestion job not found');
      }
      res.json({
        jobId: job.id,
        fileName: job.fileName,
        totalRecords: job.totalRecords,
        processedRecords: job.processedRecords,
        skippedRecords: job.skippedRecords,
        status: job.status,
        error: job.error,
      });
    } catch (error) {
      next(error);
    }
  });

  return router;
}
