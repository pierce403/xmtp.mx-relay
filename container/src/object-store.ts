import fs from 'node:fs';
import { mkdir, readFile, rename, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';

export class ObjectNotFoundError extends Error {
  constructor(readonly key: string) {
    super(`Object not found: ${key}`);
    this.name = 'ObjectNotFoundError';
  }
}

export class ObjectStoreRequestError extends Error {
  constructor(
    readonly status: number,
    readonly responseBody: string,
  ) {
    super(`Object-store request failed (${status}): ${responseBody}`);
    this.name = 'ObjectStoreRequestError';
  }
}

export const MAX_HTTP_OBJECT_BYTES = 32 * 1024 * 1024;

export interface ObjectStore {
  getBytes(key: string, maxBytes?: number): Promise<Uint8Array>;
  getToFile(key: string, destination: string): Promise<void>;
  putBytes(key: string, value: Uint8Array, sha256: string): Promise<void>;
  putBytesIfAbsent(key: string, value: Uint8Array, sha256: string): Promise<boolean>;
  putFile(key: string, source: string, sha256: string): Promise<void>;
}

function validateKey(key: string): string {
  if (!key || key.includes('\0') || key.startsWith('/') || key.split('/').some((part) => part === '..')) {
    throw new Error(`Unsafe object key: ${JSON.stringify(key)}`);
  }
  return key;
}

async function responseError(response: Response): Promise<Error> {
  const body = (await response.text()).slice(0, 4_096);
  return new ObjectStoreRequestError(response.status, body || response.statusText);
}

export class HttpObjectStore implements ObjectStore {
  private readonly maxObjectBytes: number;

  constructor(
    private readonly baseUrl: string,
    private readonly sharedSecret: string,
    private readonly timeoutMs = 180_000,
    maxObjectBytes = MAX_HTTP_OBJECT_BYTES,
  ) {
    if (!Number.isSafeInteger(maxObjectBytes) || maxObjectBytes < 1) {
      throw new Error('HttpObjectStore maxObjectBytes must be a positive integer');
    }
    // This is a process-local invariant, independent of Worker configuration.
    // No caller can re-enable the obsolete whole-database request path.
    this.maxObjectBytes = Math.min(maxObjectBytes, MAX_HTTP_OBJECT_BYTES);
  }

  private urlFor(key: string): string {
    return `${this.baseUrl}/v1/objects/${encodeURIComponent(validateKey(key))}`;
  }

  private headers(sha256?: string): Headers {
    const headers = new Headers({ authorization: `Bearer ${this.sharedSecret}` });
    if (sha256) headers.set('x-object-sha256', sha256);
    return headers;
  }

  private async get(key: string): Promise<Response> {
    const response = await fetch(this.urlFor(key), {
      method: 'GET',
      headers: this.headers(),
      signal: AbortSignal.timeout(this.timeoutMs),
    });
    if (response.status === 404) throw new ObjectNotFoundError(key);
    if (!response.ok) throw await responseError(response);
    return response;
  }

  async getBytes(key: string, maxBytes = 2 * 1024 * 1024): Promise<Uint8Array> {
    const response = await this.get(key);
    const lengthHeader = response.headers.get('content-length');
    if (lengthHeader && Number(lengthHeader) > maxBytes) {
      await response.body?.cancel();
      throw new Error(`Object ${key} exceeds ${maxBytes} bytes`);
    }
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (bytes.byteLength > maxBytes) throw new Error(`Object ${key} exceeds ${maxBytes} bytes`);
    return bytes;
  }

  async getToFile(key: string, destination: string): Promise<void> {
    const response = await this.get(key);
    if (!response.body) throw new Error(`Object ${key} has no response body`);
    const declaredLength = Number(response.headers.get('content-length'));
    if (Number.isFinite(declaredLength) && declaredLength > this.maxObjectBytes) {
      await response.body.cancel();
      throw new Error(`Object ${key} exceeds ${this.maxObjectBytes} bytes`);
    }
    await mkdir(path.dirname(destination), { recursive: true });
    const temporary = `${destination}.download-${process.pid}-${Date.now()}`;
    try {
      const body = Readable.fromWeb(response.body as import('node:stream/web').ReadableStream<Uint8Array>);
      let downloadedBytes = 0;
      const thisMaxObjectBytes = this.maxObjectBytes;
      const limiter = new Transform({
        transform(chunk: Buffer, _encoding, callback) {
          downloadedBytes += chunk.length;
          if (downloadedBytes > thisMaxObjectBytes) {
            callback(new Error(`Object ${key} exceeds ${thisMaxObjectBytes} bytes`));
            return;
          }
          callback(null, chunk);
        },
      });
      await pipeline(body, limiter, fs.createWriteStream(temporary, { flags: 'wx', mode: 0o600 }));
      await rename(temporary, destination);
    } catch (error) {
      await fs.promises.rm(temporary, { force: true });
      throw error;
    }
  }

  async putBytes(key: string, value: Uint8Array, sha256: string): Promise<void> {
    if (value.byteLength > this.maxObjectBytes) {
      throw new Error(`Object ${key} exceeds ${this.maxObjectBytes} bytes`);
    }
    const headers = this.headers(sha256);
    headers.set('content-length', String(value.byteLength));
    const response = await fetch(this.urlFor(key), {
      method: 'PUT',
      headers,
      body: Buffer.from(value),
      signal: AbortSignal.timeout(this.timeoutMs),
    });
    if (!response.ok) throw await responseError(response);
  }

  async putBytesIfAbsent(key: string, value: Uint8Array, sha256: string): Promise<boolean> {
    if (value.byteLength > this.maxObjectBytes) {
      throw new Error(`Object ${key} exceeds ${this.maxObjectBytes} bytes`);
    }
    const headers = this.headers(sha256);
    headers.set('content-length', String(value.byteLength));
    headers.set('if-none-match', '*');
    const response = await fetch(this.urlFor(key), {
      method: 'PUT',
      headers,
      body: Buffer.from(value),
      signal: AbortSignal.timeout(this.timeoutMs),
    });
    if (response.status === 409 || response.status === 412) return false;
    if (!response.ok) throw await responseError(response);
    return true;
  }

  async putFile(key: string, source: string, sha256: string): Promise<void> {
    const details = await stat(source);
    if (!details.isFile()) throw new Error(`Backup source is not a regular file: ${source}`);
    if (details.size > this.maxObjectBytes) {
      throw new Error(`Object ${key} exceeds ${this.maxObjectBytes} bytes`);
    }
    const body = fs.createReadStream(source);
    const headers = this.headers(sha256);
    headers.set('content-length', String(details.size));
    headers.set('if-none-match', '*');
    const init: RequestInit & { duplex: 'half' } = {
      method: 'PUT',
      headers,
      body: Readable.toWeb(body) as unknown as BodyInit,
      duplex: 'half',
      signal: AbortSignal.timeout(this.timeoutMs),
    };
    const response = await fetch(this.urlFor(key), init);
    if (!response.ok) throw await responseError(response);
  }
}

/** Filesystem-backed implementation used only by offline tooling and tests. */
export class DirectoryObjectStore implements ObjectStore {
  constructor(private readonly root: string) {}

  private resolve(key: string): string {
    const validated = validateKey(key);
    const resolved = path.resolve(this.root, validated);
    const rootWithSeparator = `${path.resolve(this.root)}${path.sep}`;
    if (!resolved.startsWith(rootWithSeparator)) throw new Error(`Object key escapes store root: ${key}`);
    return resolved;
  }

  async getBytes(key: string, maxBytes = 2 * 1024 * 1024): Promise<Uint8Array> {
    const filename = this.resolve(key);
    let details;
    try {
      details = await stat(filename);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') throw new ObjectNotFoundError(key);
      throw error;
    }
    if (details.size > maxBytes) throw new Error(`Object ${key} exceeds ${maxBytes} bytes`);
    return readFile(filename);
  }

  async getToFile(key: string, destination: string): Promise<void> {
    const source = this.resolve(key);
    try {
      await stat(source);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') throw new ObjectNotFoundError(key);
      throw error;
    }
    await mkdir(path.dirname(destination), { recursive: true });
    await fs.promises.copyFile(source, destination, fs.constants.COPYFILE_EXCL);
  }

  async putBytes(key: string, value: Uint8Array, _sha256: string): Promise<void> {
    const destination = this.resolve(key);
    await mkdir(path.dirname(destination), { recursive: true });
    const temporary = `${destination}.upload-${process.pid}-${Date.now()}`;
    await writeFile(temporary, value, { mode: 0o600, flag: 'wx' });
    await rename(temporary, destination);
  }

  async putBytesIfAbsent(key: string, value: Uint8Array, _sha256: string): Promise<boolean> {
    const destination = this.resolve(key);
    await mkdir(path.dirname(destination), { recursive: true });
    try {
      await writeFile(destination, value, { mode: 0o600, flag: 'wx' });
      return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EEXIST') return false;
      throw error;
    }
  }

  async putFile(key: string, source: string, _sha256: string): Promise<void> {
    const destination = this.resolve(key);
    await mkdir(path.dirname(destination), { recursive: true });
    const temporary = `${destination}.upload-${process.pid}-${Date.now()}`;
    await fs.promises.copyFile(source, temporary, fs.constants.COPYFILE_EXCL);
    await rename(temporary, destination);
  }
}
