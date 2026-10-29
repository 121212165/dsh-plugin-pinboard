/** Assembly-layer harness for pinboard: a scripted mock dsh context that the
 * real apply() wires against. Captures command/tool registrations and the
 * system-prompt section provider so tests can pin notes and watch them reach
 * the prompt over a real temp directory. The mock itself lives in
 * @dsh-family/kit; this file adds pinboard's config defaults.
 * @module test/harness */

import { join } from 'node:path';

import { applyOnce, createMockCtx, tempDir } from '@dsh-family/kit/kit/test-harness';

export interface CapturedCommand {
  name: string;
  description: string;
  handler: (args: { rawInput?: string }) => { kind: string; text: string };
}

export interface CapturedTool {
  name: string;
  execute: (args: Record<string, unknown>) => Promise<string>;
}

export interface CapturedSection {
  name: string;
  order: number;
  text: () => string;
}

export interface Harness {
  commands: CapturedCommand[];
  tools: CapturedTool[];
  sections: CapturedSection[];
  dataPath: string;
  apply(config: Record<string, unknown>): Promise<void>;
  command(name: string): CapturedCommand;
  tool(name: string): CapturedTool;
  sectionText(): string;
}

export function makeHarness(): Harness {
  const mock = createMockCtx<CapturedCommand, CapturedTool, CapturedSection>();
  const dataPath = join(tempDir('pinboard-wire-'), 'pins.jsonl');

  // apply once per harness — a second call would double-register.
  // Schema defaults (limit/maxChars/order) only apply through the host —
  // a direct apply() call gets the plain object, so restate the defaults.
  let pending: Record<string, unknown> = {};
  let mounted = false;
  const applied = applyOnce(() =>
    import('../src/plugin.ts').then(({ apply }) => apply(mock.ctx as never, {
      enabled: true,
      limit: 12,
      maxChars: 1200,
      order: 700,
      factLimit: 10,
      // never let a test read the real ~/.dsh/fact-vault/facts.jsonl
      factsPath: join(dataPath, '..', 'no-fact-vault.jsonl'),
      dataPath,
      ...pending,
    } as never)),
  );

  return {
    commands: mock.commands,
    tools: mock.tools,
    sections: mock.sections,
    dataPath,
    apply(config: Record<string, unknown>) {
      if (!mounted) {
        mounted = true;
        pending = config;
      }
      return applied();
    },
    command: mock.command,
    tool: mock.tool,
    sectionText(): string {
      return mock.section('pinboard').text();
    },
  };
}
