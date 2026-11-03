import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { DeleteObjectCommand, GetObjectCommand, PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import type { Config } from '../config';

/**
 * Armazenamento de comprovantes (ADR-0006). Os bytes chegam ao storage já
 * cifrados com AES-256-GCM; o storage nunca vê o conteúdo. Formato gravado:
 * "FF1" (3 bytes) + IV (12) + tag (16) + dados cifrados.
 */

export interface Storage {
  put(key: string, plain: Buffer): Promise<void>;
  get(key: string): Promise<Buffer>;
  delete(key: string): Promise<void>;
}

interface RawStore {
  put(key: string, data: Buffer): Promise<void>;
  get(key: string): Promise<Buffer>;
  delete(key: string): Promise<void>;
}

const MAGIC = Buffer.from('FF1');

export function encrypt(key: Buffer, plain: Buffer): Buffer {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const data = Buffer.concat([cipher.update(plain), cipher.final()]);
  return Buffer.concat([MAGIC, iv, cipher.getAuthTag(), data]);
}

export function decrypt(key: Buffer, blob: Buffer): Buffer {
  if (!blob.subarray(0, 3).equals(MAGIC)) throw new Error('Formato de comprovante desconhecido.');
  const iv = blob.subarray(3, 15);
  const tag = blob.subarray(15, 31);
  const decipher = createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(blob.subarray(31)), decipher.final()]);
}

class LocalStore implements RawStore {
  constructor(private readonly dir: string) {}
  private file(key: string) {
    if (!/^[a-z0-9/_-]+$/i.test(key)) throw new Error('Chave de storage inválida.');
    return path.join(this.dir, key);
  }
  async put(key: string, data: Buffer) {
    const f = this.file(key);
    await fs.mkdir(path.dirname(f), { recursive: true });
    await fs.writeFile(f, data);
  }
  get(key: string) {
    return fs.readFile(this.file(key));
  }
  async delete(key: string) {
    await fs.rm(this.file(key), { force: true });
  }
}

/** Cloudflare R2 (ou qualquer S3) por credencial de acesso. */
class S3Store implements RawStore {
  private readonly client: S3Client;
  constructor(
    private readonly bucket: string,
    config: Config,
  ) {
    this.client = new S3Client({
      region: config.S3_REGION,
      endpoint: config.S3_ENDPOINT,
      credentials: { accessKeyId: config.S3_ACCESS_KEY_ID!, secretAccessKey: config.S3_SECRET_ACCESS_KEY! },
    });
  }
  async put(key: string, data: Buffer) {
    await this.client.send(new PutObjectCommand({ Bucket: this.bucket, Key: key, Body: data, ContentType: 'application/octet-stream' }));
  }
  async get(key: string) {
    const r = await this.client.send(new GetObjectCommand({ Bucket: this.bucket, Key: key }));
    return Buffer.from(await r.Body!.transformToByteArray());
  }
  async delete(key: string) {
    await this.client.send(new DeleteObjectCommand({ Bucket: this.bucket, Key: key }));
  }
}

class EncryptedStorage implements Storage {
  constructor(
    private readonly raw: RawStore,
    private readonly key: Buffer,
  ) {}
  put(key: string, plain: Buffer) {
    return this.raw.put(key, encrypt(this.key, plain));
  }
  async get(key: string) {
    return decrypt(this.key, await this.raw.get(key));
  }
  delete(key: string) {
    return this.raw.delete(key);
  }
}

export function createStorage(config: Config): Storage {
  const key = Buffer.from(config.ATTACHMENTS_KEY, 'base64');
  const raw = config.STORAGE_DRIVER === 's3' ? new S3Store(config.S3_BUCKET!, config) : new LocalStore(path.resolve(config.STORAGE_LOCAL_DIR));
  return new EncryptedStorage(raw, key);
}

/** Storage em memória para testes. */
export function memoryStorage(key: Buffer): Storage & { blobs: Map<string, Buffer> } {
  const blobs = new Map<string, Buffer>();
  const raw: RawStore = {
    put: async (k, d) => void blobs.set(k, d),
    get: async (k) => {
      const v = blobs.get(k);
      if (!v) throw new Error('not found');
      return v;
    },
    delete: async (k) => void blobs.delete(k),
  };
  return Object.assign(new EncryptedStorage(raw, key), { blobs });
}
