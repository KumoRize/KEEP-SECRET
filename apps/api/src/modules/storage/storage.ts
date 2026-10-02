import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, join, resolve, sep } from 'node:path';
import { GetObjectCommand, PutObjectCommand, DeleteObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { config } from '../../config.js';
import { signPayload, verifyPayload } from '../../lib/crypto.js';

export interface Storage {
  put(key: string, data: Buffer, contentType: string): Promise<void>;
  delete(key: string): Promise<void>;
  /** Short-lived URL; `inline` lets browsers render previews, otherwise forces download. */
  url(key: string, opts: { filename: string; contentType: string; inline: boolean }): Promise<string>;
}

export interface FileToken {
  k: string;
  fn: string;
  ct: string;
  in: boolean;
  exp: number;
}

const URL_TTL_SEC = 3600;

class LocalStorage implements Storage {
  private root = resolve(config.STORAGE_LOCAL_DIR);

  path(key: string): string {
    const p = resolve(join(this.root, key));
    if (!p.startsWith(this.root + sep)) throw new Error('invalid storage key');
    return p;
  }

  async put(key: string, data: Buffer): Promise<void> {
    const p = this.path(key);
    await mkdir(dirname(p), { recursive: true });
    await writeFile(p, data);
  }

  async read(key: string): Promise<Buffer> {
    return readFile(this.path(key));
  }

  async delete(key: string): Promise<void> {
    await rm(this.path(key), { force: true });
  }

  async url(key: string, opts: { filename: string; contentType: string; inline: boolean }): Promise<string> {
    const token: FileToken = { k: key, fn: opts.filename, ct: opts.contentType, in: opts.inline, exp: Math.floor(Date.now() / 1000) + URL_TTL_SEC };
    return `${config.PUBLIC_URL}/files/${signPayload(config.FILE_URL_SECRET, token)}`;
  }
}

class S3Storage implements Storage {
  private s3 = new S3Client({ region: config.S3_REGION, endpoint: config.S3_ENDPOINT, forcePathStyle: Boolean(config.S3_ENDPOINT) });
  private bucket = config.S3_BUCKET!;

  async put(key: string, data: Buffer, contentType: string): Promise<void> {
    await this.s3.send(new PutObjectCommand({ Bucket: this.bucket, Key: key, Body: data, ContentType: contentType }));
  }

  async delete(key: string): Promise<void> {
    await this.s3.send(new DeleteObjectCommand({ Bucket: this.bucket, Key: key }));
  }

  async url(key: string, opts: { filename: string; contentType: string; inline: boolean }): Promise<string> {
    const disposition = `${opts.inline ? 'inline' : 'attachment'}; filename="${opts.filename.replace(/[^\w.-]/g, '_')}"`;
    return getSignedUrl(
      this.s3,
      new GetObjectCommand({ Bucket: this.bucket, Key: key, ResponseContentDisposition: disposition, ResponseContentType: opts.contentType }),
      { expiresIn: URL_TTL_SEC },
    );
  }
}

export const storage: Storage = config.STORAGE_DRIVER === 's3' ? new S3Storage() : new LocalStorage();

export function verifyFileToken(token: string): FileToken | null {
  const t = verifyPayload<FileToken>(config.FILE_URL_SECRET, token);
  return t && t.exp > Date.now() / 1000 ? t : null;
}

export const localStorage = storage instanceof LocalStorage ? storage : null;
