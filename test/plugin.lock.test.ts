/** Store-level lock semantics: 8 real child processes each keep their pin,
 * a stale lock is taken over, a fresh foreign lock degrades to an unlocked
 * save without deleting it. @module test/plugin.lock */

import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';

import { addPin, LOCK_STALE_MS, LOCK_TIMEOUT_MS, PinStore } from '../src/plugin.ts';
import type { Pin } from '../src/pins.ts';

const tempDirs: string[] = [];

function newStore(): PinStore {
  const dir = mkdtempSync(join(tmpdir(), 'pinboard-lock-'));
  tempDirs.push(dir);
  return new PinStore(join(dir, 'pins.jsonl'));
}

after(() => {
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
});

const writeThrough = (text: string) => (items: Pin[]): Pin[] => {
  const result = addPin(items, text, 'user');
  return result.kind === 'added' ? result.items : items;
};

test('mutate adds under a clean lock and removes the lock afterwards', () => {
  const store = newStore();
  store.warn = (message) => assert.fail(`unexpected warning: ${message}`);
  store.mutate(writeThrough('第一条锁内便签'));
  assert.ok(store.load().some((pin) => pin.text === '第一条锁内便签'));
  assert.ok(!existsSync(`${store.path}.lock`), 'lock must be released');
});

test('8 concurrent child processes each keep their pin line', async () => {
  const store = newStore();
  const markers = Array.from({ length: 8 }, (_, index) => `LOCK-C${index + 1}-${Date.now().toString(36)}`);
  const children = markers.map((marker) =>
    spawn(process.execPath, [join(import.meta.dirname, 'mutate-worker.mjs'), store.path, marker], { stdio: 'pipe' }),
  );
  await Promise.all(
    children.map((child) => new Promise<void>((resolve, reject) => {
      let stderr = '';
      child.stderr?.on('data', (chunk) => { stderr += chunk; });
      child.on('exit', (code) => (code === 0 ? resolve() : reject(new Error(`worker exit ${code}: ${stderr}`))));
      child.on('error', reject);
    })),
  );
  const text = readFileSync(store.path, 'utf8');
  for (const marker of markers) assert.ok(text.includes(marker), `missing ${marker}`);
});

test('a stale lock is taken over', () => {
  const store = newStore();
  const lockPath = `${store.path}.lock`;
  writeFileSync(lockPath, 'held by a dead process');
  const old = new Date(Date.now() - LOCK_STALE_MS - 1000);
  utimesSync(lockPath, old, old);
  store.mutate(writeThrough('接管陈锁后的便签'));
  assert.ok(store.load().some((pin) => pin.text === '接管陈锁后的便签'));
  assert.ok(!existsSync(lockPath), 'stale lock must not survive');
});

test('a fresh foreign lock degrades after the deadline and is left alone', () => {
  const store = newStore();
  const lockPath = `${store.path}.lock`;
  writeFileSync(lockPath, 'held by a live process');
  try {
    let warned = '';
    store.warn = (message) => { warned = message; };
    const start = Date.now();
    store.mutate(writeThrough('降级直写的便签'));
    assert.ok(Date.now() - start >= LOCK_TIMEOUT_MS - 20, 'must wait out the deadline');
    assert.match(warned, /lock busy/);
    assert.ok(store.load().some((pin) => pin.text === '降级直写的便签'));
    assert.ok(existsSync(lockPath), 'degraded save must not delete a foreign lock');
  } finally {
    rmSync(lockPath, { force: true });
  }
});
