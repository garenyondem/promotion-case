import { createReadStream, createWriteStream, promises as fsp } from 'node:fs';
import { basename, join } from 'node:path';
import { pipeline } from 'node:stream/promises';
import type { Readable } from 'node:stream';
import { S3Client, PutObjectCommand, GetObjectCommand, DeleteObjectCommand } from '@aws-sdk/client-s3';
import { env } from '../config/env';

export interface StoredFile {
  path: string;
  size: number;
}

export interface Storage {
  saveFile(filename: string, stream: Readable): Promise<StoredFile>;
  openReadStream(path: string): Promise<Readable>;
  deleteFile(path: string): Promise<void>;
}

export class LocalStorage implements Storage {
  constructor(private readonly dir: string) {}

  async saveFile(filename: string, stream: Readable): Promise<StoredFile> {
    await fsp.mkdir(this.dir, { recursive: true });
    const path = join(this.dir, `${Date.now()}-${basename(filename)}`);
    await pipeline(stream, createWriteStream(path));
    const stat = await fsp.stat(path);
    return { path, size: stat.size };
  }

  async openReadStream(path: string): Promise<Readable> {
    return createReadStream(path);
  }

  async deleteFile(path: string): Promise<void> {
    await fsp.rm(path, { force: true });
  }
}

export class S3Storage implements Storage {
  constructor(
    private readonly bucket: string,
    private readonly client: S3Client,
  ) {}

  async saveFile(filename: string, stream: Readable): Promise<StoredFile> {
    const key = `${Date.now()}-${basename(filename)}`;
    await this.client.send(new PutObjectCommand({ Bucket: this.bucket, Key: key, Body: stream }));
    return { path: key, size: 0 };
  }

  async openReadStream(key: string): Promise<Readable> {
    const response = await this.client.send(new GetObjectCommand({ Bucket: this.bucket, Key: key }));
    return response.Body as unknown as Readable;
  }

  async deleteFile(key: string): Promise<void> {
    await this.client.send(new DeleteObjectCommand({ Bucket: this.bucket, Key: key }));
  }
}

export function buildStorage(): Storage {
  if (env.STORAGE_DRIVER === 's3') {
    return new S3Storage(env.INGEST_BUCKET, new S3Client({ region: env.AWS_REGION }));
  }
  return new LocalStorage(env.UPLOAD_DIR);
}
