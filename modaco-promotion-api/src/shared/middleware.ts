import type { NextFunction, Request, Response } from 'express';
import { Prisma } from '@prisma/client';
import { ZodError } from 'zod';
import { AppError } from './errors';
import { logger } from './logger';

export function notFoundHandler(_req: Request, res: Response): void {
  res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Route not found' } });
}

function sendError(res: Response, status: number, code: string, message: string): void {
  res.status(status).json({ error: { code, message } });
}

function isBodyParserError(err: unknown): err is { type: string; status: number } {
  return (
    typeof err === 'object' &&
    err !== null &&
    'type' in err &&
    typeof (err as { type: unknown }).type === 'string'
  );
}

export function errorHandler(
  err: unknown,
  _req: Request,
  res: Response,
  _next: NextFunction,
): void {
  if (err instanceof AppError) {
    sendError(res, err.status, err.code, err.message);
    return;
  }
  if (err instanceof ZodError) {
    const message = err.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ');
    sendError(res, 400, 'VALIDATION_ERROR', message);
    return;
  }
  if (err instanceof Prisma.PrismaClientKnownRequestError) {
    switch (err.code) {
      case 'P2002':
        sendError(res, 409, 'CONFLICT', 'Resource already exists');
        return;
      case 'P2023':
      case 'P2025':
        sendError(res, 404, 'NOT_FOUND', 'Resource not found');
        return;
      case 'P2010': {
        const meta = err.meta as { code?: string } | undefined;
        if (meta?.code === '22003') {
          sendError(res, 400, 'VALIDATION_ERROR', 'Numeric value out of range');
          return;
        }
        break;
      }
      default:
        break;
    }
  }
  if (err instanceof Prisma.PrismaClientValidationError) {
    sendError(res, 400, 'VALIDATION_ERROR', 'Invalid input');
    return;
  }
  if (isBodyParserError(err)) {
    if (err.type === 'entity.too.large') {
      sendError(res, 413, 'PAYLOAD_TOO_LARGE', 'Request body too large');
      return;
    }
    if (err.type === 'entity.parse.failed') {
      sendError(res, 400, 'BAD_REQUEST', 'Malformed request body');
      return;
    }
  }
  logger.error('unhandled error', { error: err instanceof Error ? err.stack : String(err) });
  sendError(res, 500, 'INTERNAL_ERROR', 'Internal server error');
}
