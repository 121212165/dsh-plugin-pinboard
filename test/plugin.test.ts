/** Wire-level assembly tests for pinboard: the real apply() against a mock
 * context, pinning notes and watching them reach the system-prompt section over
 * a real temp directory. First assembly coverage for this plugin (family audit:
 * all P0/P1 lived in plugin.ts with zero tests).
 * @module test/plugin.test */

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { makeHarness, type Harness } from './harness.ts';

async function mounted(config: Record<string, unknown> = {}): Promise<Harness> {
  const harness = makeHarness();
  await harness.apply(config);
  return harness;
}

test('bad config fails loud naming pinboard; disabled mounts nothing', async () => {
  const bad = makeHarness();
  await assert.rejects(bad.apply({ order: Number.NaN }), /pinboard: order must be a finite number/);

  const off = makeHarness();
  await off.apply({ enabled: false });
  assert.equal(off.commands.length, 0);
  assert.equal(off.tools.length, 0);
  assert.equal(off.sections.length, 0);
});

test('apply wires three commands, the pin_add tool, and the prompt section', async () => {
  const harness = await mounted();
  assert.deepEqual(
    harness.commands.map((command) => command.name).sort(),
    ['pin', 'pins', 'unpin'],
  );
  assert.equal(harness.tool('pin_add').name, 'pin_add');
  const section = harness.sections.find((candidate) => candidate.name === 'pinboard');
  assert.ok(section, 'prompt section registered');
});

test('a pinned note reaches the prompt section on the next assembly read', async () => {
  const harness = await mounted();
  assert.equal(harness.sectionText(), ''); // nothing pinned yet

  const text = harness.command('pin').handler({ rawInput: '以后都用中文回复' }).text;
  assert.ok(text.includes('#1'), text);

  const section = harness.sectionText();
  assert.ok(section.startsWith('## 置顶便签（pinboard）'));
  assert.ok(section.includes('以后都用中文回复'));
});

test('duplicate pins are refused with the existing id', async () => {
  const harness = await mounted();
  harness.command('pin').handler({ rawInput: '只回中文' });
  const again = harness.command('pin').handler({ rawInput: '只回中文' });
  assert.equal(again.kind, 'success');
  assert.ok(again.text.includes('已经置顶过了'), again.text);
  assert.ok(again.text.includes('#1'));
});

test('/unpin removes the note from the prompt; unknown ids error', async () => {
  const harness = await mounted();
  harness.command('pin').handler({ rawInput: '临时约定' });

  const missing = harness.command('unpin').handler({ rawInput: '99' });
  assert.equal(missing.kind, 'error');

  const removed = harness.command('unpin').handler({ rawInput: '#1' });
  assert.ok(removed.text.includes('已取消'), removed.text);
  assert.equal(harness.sectionText(), '');
});

test('/pins renders the list with injection marks', async () => {
  const harness = await mounted();
  assert.ok(harness.command('pins').handler({}).text.includes('空的'));

  harness.command('pin').handler({ rawInput: '第一条' });
  const list = harness.command('pins').handler({}).text;
  assert.ok(list.includes('● [#1]'), list);
  assert.ok(list.includes('注入 1 条'), list);
});

test('pin_add tool pins; with a degenerate char budget it reports the pin staying out', async () => {
  // NOTE (finding, not fixed): with the normal budget the newest pin is ALWAYS
  // injected (an oversized line is truncated in, never dropped), so pin_add's
  // "超出预算，暂不会注入" note is only reachable when maxChars < 3 — the
  // messaging overstates what the budget can do. Kept as behavior documentation.
  const degenerate = await mounted({ maxChars: 2 });
  const out = await degenerate.tool('pin_add').execute({ text: '这条进不了提示' });
  assert.ok(out.includes('超出预算'), out);
  assert.equal(degenerate.sectionText(), '');

  const harness = await mounted();
  const ok = await harness.tool('pin_add').execute({ text: '代理置顶的约定' });
  assert.ok(ok.includes('#1'), ok);
  assert.ok(!ok.includes('超出预算'), ok);
  assert.ok(harness.sectionText().includes('代理置顶的约定'));

  // an oversized pin is truncated into the prompt rather than dropped
  const cramped = await mounted({ maxChars: 30 });
  await cramped.tool('pin_add').execute({ text: '很长'.repeat(20) });
  const section = cramped.sectionText();
  assert.ok(section.length < 200);
  assert.ok(section.includes('…'), 'truncation marker present');
});
