/**
 * dsh wiring for pinboard: notes pinned once in any session reach every future
 * session through a system-prompt section. The section text is a provider, so
 * pins added mid-run appear on the next assembly without restarting dsh.
 */
import type { Context } from '@deepseek-ai/cordis';
import Schema from '@deepseek-ai/schemastery';
import { defineTool } from '@deepseek-ai/dsh-tools';
import type {} from '@deepseek-ai/dsh-commands';
import type {} from '@deepseek-ai/dsh-system-prompt';
import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

import {
  addPin,
  removePin,
  parseLibrary,
  renderList,
  renderSection,
  activePins,
  type Pin,
  type PromptBudget,
} from './pins.ts';

export const name = 'pinboard';
export const inject = ['commands', 'tools', 'systemPrompt'];

export interface Config {
  enabled: boolean;
  dataPath?: string;
  limit: number;
  maxChars: number;
  order: number;
}

export const Config = Schema.object({
  enabled: Schema.boolean().default(true),
  dataPath: Schema.string(),
  limit: Schema.natural().default(12),
  maxChars: Schema.natural().default(1200),
  order: Schema.number().default(700),
});

export function expandHome(path: string): string {
  return path.startsWith('~') ? join(homedir(), path.slice(1)) : path;
}

export class PinStore {
  readonly path: string;

  constructor(dataPath: string | undefined) {
    this.path = dataPath ? expandHome(dataPath) : join(homedir(), '.dsh', 'pinboard', 'pins.jsonl');
  }

  load(): Pin[] {
    if (!existsSync(this.path)) return [];
    return parseLibrary(readFileSync(this.path, 'utf8')).items;
  }

  save(items: Pin[]): void {
    const index = Math.max(this.path.lastIndexOf('/'), this.path.lastIndexOf('\\'));
    mkdirSync(index === -1 ? '.' : this.path.slice(0, index), { recursive: true });
    writeFileSync(this.path, items.map((item) => JSON.stringify(item)).join('\n') + '\n', 'utf8');
  }
}

export function apply(ctx: Context, config: Config): void {
  const log = ctx.logger('pinboard');
  if (!config.enabled) return void log.info('disabled by config');
  if (!Number.isFinite(config.order)) throw new TypeError('pinboard: order must be a finite number');
  const store = new PinStore(config.dataPath);
  const budget: PromptBudget = { limit: config.limit, maxChars: config.maxChars };

  const add = (text: string, source: Pin['source']) => {
    const items = store.load();
    const result = addPin(items, text, source);
    if (result.kind === 'added') store.save(result.items);
    return result;
  };

  ctx.systemPrompt.section({
    name: 'pinboard',
    order: config.order,
    text: () => {
      try {
        return renderSection(store.load(), budget);
      } catch (error) {
        log.warn(`pinboard section skipped: ${String(error)}`);
        return '';
      }
    },
  });

  ctx.commands.register({
    name: 'pin',
    description: '置顶一条便签，注入之后每个会话的系统提示：/pin <一句话>',
    input: { hint: '<一句话>' },
    handler: ({ rawInput }) => {
      const result = add(String(rawInput ?? ''), 'user');
      if (result.kind === 'empty') return { kind: 'error', text: '便签内容为空。用法：/pin <一句话>' };
      if (result.kind === 'duplicate') return { kind: 'success', text: `已经置顶过了：[#${result.pin.id}] ${result.pin.text}` };
      return { kind: 'success', text: `已置顶 [#${result.pin.id}] ${result.pin.text}（下一个回合起注入系统提示；/pins 查看，/unpin ${result.pin.id} 取消）` };
    },
  });

  ctx.commands.register({
    name: 'unpin',
    description: '取消置顶：/unpin <id>',
    input: { hint: '<id>' },
    handler: ({ rawInput }) => {
      const id = String(rawInput ?? '').trim();
      if (!id) return { kind: 'error', text: '用法：/unpin <id>（id 见 /pins）' };
      const items = store.load();
      const { items: kept, removed } = removePin(items, id);
      if (!removed) return { kind: 'error', text: `没有 [#${id}]，/pins 看现有便签` };
      store.save(kept);
      return { kind: 'success', text: `已取消 [#${removed.id}] ${removed.text}` };
    },
  });

  ctx.commands.register({
    name: 'pins',
    description: '列出置顶便签并标出哪些真的注入了系统提示',
    handler: () => {
      let skipped = 0;
      if (existsSync(store.path)) skipped = parseLibrary(readFileSync(store.path, 'utf8')).skipped;
      const text = renderList(store.load(), budget);
      return { kind: 'success', text: skipped ? `${text}\n⚠ ${skipped} 行损坏被跳过` : text };
    },
  });

  ctx.tools.register(
    defineTool({
      name: 'pin_add',
      description: '把一条长期有效的约定置顶，之后每个会话的系统提示都会带上它。只在用户明确要求"记住/以后都"时使用。',
      parameters: {
        text: { type: 'string', required: true, description: '一句话，会压成单行存储' },
      },
      output: {
        schema: { type: 'string' } as const,
        render: (_args, value) => [{ type: 'text', text: value }],
      },
      async execute(args) {
        const result = add(args.text, 'agent');
        if (result.kind === 'empty') return '内容为空，未置顶。';
        if (result.kind === 'duplicate') return `已存在 [#${result.pin.id}]：${result.pin.text}`;
        const injected = activePins(store.load(), budget).some((pin) => pin.id === result.pin.id);
        return `已置顶 [#${result.pin.id}] ${result.pin.text}${injected ? '' : '（超出预算，暂不会注入系统提示——/pins 查看）'}`;
      },
    }),
  );

  log.info(`mounted · ${store.path} · limit=${config.limit} maxChars=${config.maxChars} order=${config.order}`);
}
