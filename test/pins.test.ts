import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  addPin,
  removePin,
  nextId,
  normalizeText,
  parseLibrary,
  byRecency,
  activePins,
  renderSection,
  renderList,
  type Pin,
  type PromptBudget,
} from '../src/pins.ts';

const budget: PromptBudget = { limit: 12, maxChars: 100 };

const pin = (over: Partial<Pin>): Pin =>
  ({ v: 1, id: '1', text: 'note', at: '2026-09-29T00:00:00.000Z', source: 'user', ...over }) as Pin;

test('addPin collapses whitespace, skips duplicates, and assigns the next id', () => {
  const empty = addPin([], '   ', 'user');
  assert.equal(empty.kind, 'empty');

  const first = addPin([], 'use   tabs\nnot spaces', 'user');
  assert.equal(first.kind, 'added');
  if (first.kind !== 'added') return;
  assert.equal(first.pin.text, 'use tabs not spaces');
  assert.equal(first.pin.id, '1');
  assert.equal(normalizeText(first.pin.text), first.pin.text);

  const again = addPin(first.items, 'use tabs not spaces', 'agent');
  assert.equal(again.kind, 'duplicate');
  if (again.kind === 'duplicate') assert.equal(again.pin.id, '1');

  const second = addPin(first.items, 'other', 'agent');
  assert.equal(second.kind, 'added');
  if (second.kind === 'added') assert.equal(second.pin.id, '2');
  assert.equal(nextId(first.items), '2');
});

test('removePin accepts the id with or without a leading #', () => {
  const items = [pin({ id: '1' }), pin({ id: '2', text: 'second' })];
  assert.equal(removePin(items, '#2').removed?.text, 'second');
  assert.equal(removePin(items, '2').items.length, 1);
  assert.equal(removePin(items, '9').removed, null);
  assert.equal(removePin(items, '9').items.length, 2);
});

test('parseLibrary drops damaged lines and counts them, never throws', () => {
  const content = [JSON.stringify(pin({ id: '1' })), '{ broken', JSON.stringify({ v: 2, id: '2' }), ''].join('\n');
  const parsed = parseLibrary(content);
  assert.equal(parsed.items.length, 1);
  assert.equal(parsed.skipped, 2);
});

test('activePins prefers newest, honours the count limit then the char budget', () => {
  const items = [
    pin({ id: '1', text: 'oldest', at: '2026-09-01T00:00:00.000Z' }),
    pin({ id: '2', text: 'middle', at: '2026-09-15T00:00:00.000Z' }),
    pin({ id: '3', text: 'newest', at: '2026-09-29T00:00:00.000Z' }),
  ];
  assert.deepEqual(
    byRecency(items).map((item) => item.id),
    ['3', '2', '1'],
  );
  assert.deepEqual(activePins(items, { limit: 2, maxChars: 100 }).map((item) => item.id), ['3', '2']);

  // each line is "- newest" (8 chars) plus a newline: 3 lines need 24 chars.
  const tight = activePins(items, { limit: 12, maxChars: 17 });
  assert.deepEqual(tight.map((item) => item.id), ['3', '2']);

  // A lone oversized pin is truncated rather than dropped, so the newest note still lands.
  const long = [pin({ id: '1', text: 'x'.repeat(500) })];
  const truncated = activePins(long, { limit: 12, maxChars: 40 });
  assert.equal(truncated.length, 1);
  // 37 chars of text + the ellipsis, so the rendered line is exactly 40 ("- " + 38).
  assert.equal(truncated[0]!.text.length, 38);
  assert.ok(truncated[0]!.text.endsWith('…'));
  assert.equal(activePins([], budget).length, 0);
});

test('renderSection is empty when nothing is pinned and leads with the header otherwise', () => {
  assert.equal(renderSection([], budget), '');
  const text = renderSection([pin({ id: '1', text: 'always answer in Chinese' })], budget);
  assert.ok(text.startsWith('## 置顶便签（pinboard）'));
  assert.ok(text.includes('- always answer in Chinese'));
  assert.equal(text.split('\n').length, 3);
});

test('renderList marks which pins actually get injected', () => {
  assert.ok(renderList([], budget).includes('空的'));
  const items = [
    pin({ id: '1', text: 'a'.repeat(30), at: '2026-09-01T00:00:00.000Z' }),
    pin({ id: '2', text: 'b'.repeat(30), at: '2026-09-29T00:00:00.000Z' }),
  ];
  const text = renderList(items, { limit: 12, maxChars: 40 });
  assert.ok(text.includes('● [#2]'));
  assert.ok(text.includes('○ [#1]'));
  assert.ok(text.includes('注入 1 条'));
  assert.ok(text.includes('/unpin')); // overflow warning
  assert.ok(renderList(items, budget).includes('注入 2 条'));
  assert.ok(!renderList(items, budget).includes('/unpin')); // nothing overflowing, no warning
});
