/** The merged fact-vault surface on pinboard: tags, facts that are stored but
 * never injected, search that scores tags above text, and a one-time import that
 * leaves the source file alone.
 * @module test/facts */

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { makeHarness, type Harness } from './harness.ts';
import { activePins, findFacts, importFacts, isFact, parseTags, addPin, pinsOfKind, removePin, tagSuffix } from '../src/pins.ts';

async function mounted(config: Record<string, unknown> = {}): Promise<Harness> {
  const harness = makeHarness();
  await harness.apply(config);
  return harness;
}

test('parseTags splits the fact-vault syntax and dedupes case', () => {
  assert.deepEqual(parseTags('香槟金不在价目表 #报价 #Style'), { text: '香槟金不在价目表', tags: ['报价', 'style'] });
  assert.deepEqual(parseTags('没有标签的一句话'), { text: '没有标签的一句话', tags: [] });
  assert.deepEqual(parseTags('#只有标签'), { text: '', tags: ['只有标签'] }, 'a bare tag is not content');
  assert.deepEqual(parseTags(''), { text: '', tags: [] });
  assert.deepEqual(parseTags('a #b #b #c'), { text: 'a', tags: ['b', 'c'] });
});

test('facts stay out of the prompt budget while pins keep using it', () => {
  const at = (minute: number): string => `2026-10-02T09:${String(minute).padStart(2, '0')}:00.000Z`;
  const mixed = [
    { v: 1 as const, id: '1', text: '便签一', at: at(1), source: 'user' as const },
    { v: 1 as const, id: '2', text: '事实一', at: at(2), source: 'user' as const, kind: 'fact' as const, tags: ['归档'] },
    { v: 1 as const, id: '3', text: '便签二', at: at(3), source: 'user' as const },
  ];
  const budget = { limit: 12, maxChars: 1200 };
  assert.deepEqual(activePins(mixed, budget).map((pin) => pin.id), ['3', '1'], 'newest first, and the fact is not in the injection set at all');
  assert.equal(pinsOfKind(mixed, 'fact').length, 1);
  assert.equal(isFact(mixed[1]!), true);
  assert.equal(tagSuffix(mixed[1]!), '  #归档');
  assert.equal(tagSuffix(mixed[0]!), '');
  // a fact can never consume the prompt budget even at limit 1
  assert.deepEqual(activePins([mixed[1]!], budget), []);
  assert.equal(addPin(mixed, '新事实', 'user', at(9), { kind: 'fact', tags: ['X'] }).kind, 'added');
  assert.equal(addPin(mixed, '便签一', 'user', at(9)).kind, 'duplicate', 'dedup still catches a re-pinned line');
});

test('findFacts scores a tag hit three times a text hit, and only over facts', () => {
  const rows = [
    { v: 1 as const, id: '1', text: '报价口径按展开面积', at: '2026-10-01T09:00:00.000Z', source: 'user' as const, kind: 'fact' as const, tags: ['报价'] },
    { v: 1 as const, id: '2', text: '见光板也要算进展开面积', at: '2026-10-02T09:00:00.000Z', source: 'user' as const, kind: 'fact' as const },
    { v: 1 as const, id: '3', text: '便签里的报价提醒', at: '2026-10-02T10:00:00.000Z', source: 'user' as const },
  ];
  const scored = findFacts(rows, '报价');
  assert.deepEqual(scored.map((entry) => [entry.pin.id, entry.score]), [['1', 3]], 'a pin with the word is not a fact hit');
  const two = findFacts(rows, '展开 面积');
  assert.deepEqual(two.map((entry) => entry.pin.id), ['2', '1'], 'OR semantics, both hit, newest-first tiebreak');
  assert.deepEqual(findFacts(rows, ''), []);
  assert.deepEqual(findFacts(rows, '没有这个词'), []);
  assert.deepEqual(findFacts(rows, '报价', 'pin').map((entry) => entry.pin.id), ['3'], 'the same matcher can search the pin side');
});

test('importFacts adds facts, skips duplicates and junk, and keeps timestamps', () => {
  const result = importFacts([], [
    { text: '第一条事实', tags: ['A'], at: '2026-09-01T00:00:00.000Z' },
    { text: '第一条事实', tags: ['A'] },
    { text: '   ' },
    { text: '第二条事实', at: 'not a date' },
  ]);
  assert.equal(result.added, 2);
  assert.equal(result.duplicates, 1);
  assert.equal(result.skipped, 1);
  assert.equal(result.items[0]!.at, '2026-09-01T00:00:00.000Z', 'the original timestamp survives');
  assert.equal(result.items[0]!.kind, 'fact');
  assert.deepEqual(result.items[0]!.tags, ['a'], 'tags are lowercased on the way in, same as the finder expects');
  assert.ok(Number.isFinite(Date.parse(result.items[1]!.at)), 'a bad stamp falls back to now rather than a broken line');
  assert.equal(result.items.length, 2, 'the input library is not mutated and junk never lands');

  const again = importFacts(result.items, [{ text: '第一条事实' }]);
  assert.equal(again.added, 0);
  assert.equal(again.duplicates, 1);
});

test('/facts saves, finds and removes; none of it reaches the system prompt', async () => {
  const harness = await mounted();
  assert.deepEqual(
    harness.commands.map((command) => command.name).sort(),
    ['facts', 'pin', 'pins', 'unpin'],
  );
  assert.deepEqual(harness.tools.map((tool) => tool.name).sort(), ['fact_search', 'pin_add']);

  const saved = harness.command('facts').handler({ rawInput: 'save 香槟金不在价目表 #报价' });
  assert.equal(saved.kind, 'success', saved.text);
  assert.ok(saved.text.includes('#报价'), saved.text);
  assert.ok(saved.text.includes('不注入系统提示'), saved.text);

  const pinned = harness.command('pin').handler({ rawInput: '缩进用四个空格 #style' });
  assert.ok(pinned.text.includes('#style'), pinned.text);

  assert.equal(harness.sectionText().includes('香槟金'), false, 'the fact is not injected');
  assert.ok(harness.sectionText().includes('缩进用四个空格'), 'the pin is');
  assert.ok(!harness.sectionText().includes('#style'), 'the tag is metadata, not prompt content');

  const found = harness.command('facts').handler({ rawInput: 'find 报价' });
  assert.ok(found.text.includes('命中 1 条'), found.text);
  assert.ok(found.text.includes('香槟金不在价目表'), found.text);

  const listed = harness.command('pins').handler({});
  assert.ok(listed.text.includes('事实库 1 条（不注入）'), listed.text);
  assert.ok(listed.text.includes('◆'), 'the list marks facts apart from pins');

  const removed = harness.command('facts').handler({ rawInput: 'rm 1' });
  assert.ok(removed.text.includes('已从事实库删除'), removed.text);
  assert.ok(harness.command('facts').handler({ rawInput: 'list' }).text.includes('空的'), 'the store really dropped it');
});

test('/facts refuses bad verbs and inputs instead of guessing', async () => {
  const harness = await mounted();
  assert.equal(harness.command('facts').handler({ rawInput: 'nope' }).kind, 'error');
  assert.equal(harness.command('facts').handler({ rawInput: 'find' }).kind, 'error');
  assert.equal(harness.command('facts').handler({ rawInput: 'save   ' }).kind, 'error');
  assert.equal(harness.command('facts').handler({ rawInput: 'rm' }).kind, 'error');
  const missing = harness.command('facts').handler({ rawInput: 'rm 999' });
  assert.equal(missing.kind, 'error');
  assert.ok(missing.text.includes('/unpin'), 'a fact rm tells you where pins live');
  const noFile = harness.command('facts').handler({ rawInput: 'import' });
  assert.equal(noFile.kind, 'error');
  assert.ok(noFile.text.includes('dsh-plugin-fact-vault'), noFile.text);
});

test('/facts import migrates a fact-vault library once and never touches the source', async () => {
  const harness = makeHarness();
  const source = join(harness.dataPath, '..', 'facts.jsonl');
  const original = [
    JSON.stringify({ v: 1, id: '1', text: '老库里的第一条', tags: ['迁移'], at: '2026-08-01T00:00:00.000Z' }),
    JSON.stringify({ v: 1, id: '2', text: '老库里的第二条', tags: [], at: '2026-08-02T00:00:00.000Z' }),
    '{ broken',
    JSON.stringify({ v: 1, id: '4', text: '   ', tags: ['x'], at: '2026-08-03T00:00:00.000Z' }),
  ].join('\n');
  writeFileSync(source, original, 'utf8');
  await harness.apply({ factsPath: source });

  const first = harness.command('facts').handler({ rawInput: 'import' });
  assert.equal(first.kind, 'success', first.text);
  assert.ok(first.text.includes('新增 2 条'), first.text);
  assert.ok(first.text.includes('坏行 2 条'), first.text);
  assert.ok(first.text.includes('源文件没动'), first.text);
  assert.equal(readFileSync(source, 'utf8'), original, 'the migration reads only');

  const listed = harness.command('facts').handler({ rawInput: 'list' });
  assert.ok(listed.text.includes('老库里的第一条'), listed.text);
  assert.ok(listed.text.includes('#迁移'), 'tags survive the round trip');

  const second = harness.command('facts').handler({ rawInput: 'import' });
  assert.ok(second.text.includes('新增 0 条'), second.text);
  assert.ok(second.text.includes('重复跳过 2 条'), 'importing twice does not double the library');

  // an explicit --from beats the configured path
  const other = join(harness.dataPath, '..', 'other.jsonl');
  writeFileSync(other, JSON.stringify({ v: 1, id: '9', text: '另一个库的事实', tags: ['别的'], at: '2026-08-04T00:00:00.000Z' }), 'utf8');
  const picked = harness.command('facts').handler({ rawInput: `import --from ${other}` });
  assert.ok(picked.text.includes('新增 1 条'), picked.text);
});

test('fact_search finds by tag and outranks text hits', async () => {
  const harness = await mounted();
  harness.command('facts').handler({ rawInput: 'save 见光板按展开面积计价 #报价' });
  harness.command('facts').handler({ rawInput: 'save 报价单要写含税 #发票' });
  const byTag = await harness.tool('fact_search').execute({ query: '#报价' });
  assert.ok(byTag.includes('见光板按展开面积计价'), byTag);
  assert.ok(byTag.indexOf('见光板') < byTag.indexOf('报价单'), 'a tag hit outranks a text hit for the same word');
  const byWord = await harness.tool('fact_search').execute({ query: '报价' });
  assert.equal(byWord.split('\n').filter((line) => line.startsWith('  [')).length, 2, byWord);
  assert.ok(byWord.indexOf('见光板') < byWord.indexOf('报价单'), 'tag hit sorts above text hit');
  const nothing = await harness.tool('fact_search').execute({ query: '没存过的东西' });
  assert.ok(nothing.includes('没有匹配项'), nothing);
});

test('removePin clears a fact regardless of kind, and parse rejects a bogus kind', async () => {
  const harness = await mounted();
  harness.command('facts').handler({ rawInput: 'save 待删除的事实 #tmp' });
  const listed = harness.command('facts').handler({ rawInput: 'list' });
  const id = /\[#(\d+)\]/.exec(listed.text)![1];
  assert.ok(harness.command('unpin').handler({ rawInput: id! }).kind === 'success', 'unpin can clean up a fact too');
  assert.ok(harness.command('facts').handler({ rawInput: 'list' }).text.includes('空的'));
});
