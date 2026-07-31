import 'dotenv/config';
import { z } from 'zod';

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().default(3000),
  DATABASE_URL: z.string().min(1),
  REDIS_URL: z.string().default('redis://localhost:6379'),
  CACHE_DRIVER: z.enum(['redis', 'memory']).default('redis'),
  CACHE_TTL_PRODUCT: z.coerce.number().default(60),
  CACHE_TTL_LISTING: z.coerce.number().default(30),
  STORAGE_DRIVER: z.enum(['local', 's3']).default('local'),
  UPLOAD_DIR: z.string().default('./data/uploads'),
  QUEUE_DIR: z.string().default('./data/queue'),
  INGEST_CHUNK_SIZE: z.coerce.number().default(1000),
  INGEST_MAX_CONCURRENCY: z.coerce.number().default(4),
  AWS_REGION: z.string().default('us-east-1'),
  AWS_ACCESS_KEY_ID: z.string().optional(),
  AWS_SECRET_ACCESS_KEY: z.string().optional(),
  INGEST_BUCKET: z.string().default('modaco-vendor-files'),
  INGEST_QUEUE_URL: z.string().optional(),
});

export type Env = z.infer<typeof envSchema>;

export const env: Env = envSchema.parse(process.env);
