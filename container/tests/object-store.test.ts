import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { HttpObjectStore, MAX_HTTP_OBJECT_BYTES } from '../src/object-store.js';

test('R2 uploads set exact Content-Length and enforce the local maximum', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'xmtp-object-store-test-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const source = path.join(root, 'database.db3');
  await fs.writeFile(source, Buffer.from('12345'));

  const originalFetch = globalThis.fetch;
  const seenLengths: string[] = [];
  const seenIfNoneMatch: Array<string | null> = [];
  globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
    const headers = new Headers(init?.headers);
    seenLengths.push(headers.get('content-length') ?? 'missing');
    seenIfNoneMatch.push(headers.get('if-none-match'));
    if (init?.body) await new Response(init.body).arrayBuffer();
    return new Response('', { status: 201 });
  }) as typeof fetch;
  t.after(() => {
    globalThis.fetch = originalFetch;
  });

  const store = new HttpObjectStore('http://xmtp-r2.internal', 's'.repeat(32), 30_000, 5);
  await store.putFile('prefix/db', source, 'a'.repeat(64));
  await store.putBytes('prefix/pin', Buffer.from('1234'), 'b'.repeat(64));
  assert.deepEqual(seenLengths, ['5', '4']);
  assert.deepEqual(seenIfNoneMatch, ['*', null]);
  await assert.rejects(store.putBytes('prefix/too-large', Buffer.from('123456'), 'c'.repeat(64)), /exceeds 5 bytes/);
});

test('bootstrap claim uses an R2 create-only precondition', async (t) => {
  const originalFetch = globalThis.fetch;
  let ifNoneMatch: string | null = null;
  globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
    ifNoneMatch = new Headers(init?.headers).get('if-none-match');
    return new Response('', { status: 412 });
  }) as typeof fetch;
  t.after(() => {
    globalThis.fetch = originalFetch;
  });

  const store = new HttpObjectStore('http://xmtp-r2.internal', 's'.repeat(32));
  assert.equal(await store.putBytesIfAbsent('prefix/bootstrap-attempt.json', Buffer.from('{}'), 'a'.repeat(64)), false);
  assert.equal(ifNoneMatch, '*');
});

test('HTTP object store cannot be configured above the hard 32 MiB request cap', async (t) => {
  const originalFetch = globalThis.fetch;
  let fetchCalled = false;
  globalThis.fetch = (async () => {
    fetchCalled = true;
    return new Response('', { status: 201 });
  }) as typeof fetch;
  t.after(() => {
    globalThis.fetch = originalFetch;
  });

  const store = new HttpObjectStore(
    'http://xmtp-r2.internal',
    's'.repeat(32),
    30_000,
    1024 * 1024 * 1024,
  );
  await assert.rejects(
    store.putBytes('prefix/obsolete-whole-db', Buffer.alloc(MAX_HTTP_OBJECT_BYTES + 1), 'd'.repeat(64)),
    /exceeds 33554432 bytes/,
  );
  assert.equal(fetchCalled, false);
});
