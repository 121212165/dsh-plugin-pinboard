/** Assembly-layer harness for pinboard: a scripted mock dsh context that the
 * real apply() wires against. Captures command/tool registrations and the
 * system-prompt section provider so tests can pin notes and watch them reach
 * the prompt over a real temp directory. Methodology: dsh-auto-review's
 * mountHarness (222★), node:test port by dsh-plugin-task-forge.
 * @module test/harness */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after } from 'node:test';

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
  const commands: CapturedCommand[] = [];
  const tools: CapturedTool[] = [];
  const sections: CapturedSection[] = [];

  const ctx = {
    logger(_name: string) {
      return { info() {}, warn() {} };
    },
    commands: {
      register(definition: CapturedCommand) {
        commands.push(definition);
      },
    },
    tools: {
      register(definition: CapturedTool) {
        tools.push(definition);
      },
    },
    systemPrompt: {
      section(section: CapturedSection) {
        sections.push(section);
      },
    },
  };

  const dataPath = join(mkdtempSync(join(tmpdir(), 'pinboard-wire-')), 'pins.jsonl');
  after(() => rmSync(join(dataPath, '..'), { recursive: true, force: true }));

  // apply once per harness — a second call would double-register.
  let applied: Promise<void> | null = null;

  const harness: Harness = {
    commands,
    tools,
    sections,
    dataPath,
    apply(config: Record<string, unknown>) {
      // Schema defaults (limit/maxChars/order) only apply through the host —
      // a direct apply() call gets the plain object, so restate the defaults.
      applied ??= import('../src/plugin.ts').then(({ apply }) => apply(ctx as never, {
        enabled: true,
        limit: 12,
        maxChars: 1200,
        order: 700,
        factLimit: 10,
        // never let a test read the real ~/.dsh/fact-vault/facts.jsonl
        factsPath: join(dataPath, '..', 'no-fact-vault.jsonl'),
        dataPath,
        ...config,
      } as never));
      return applied;
    },
    command(name: string): CapturedCommand {
      const found = commands.find((candidate) => candidate.name === name);
      if (!found) throw new Error(`command ${name} was never registered`);
      return found;
    },
    tool(name: string): CapturedTool {
      const found = tools.find((candidate) => candidate.name === name);
      if (!found) throw new Error(`tool ${name} was never registered`);
      return found;
    },
    sectionText(): string {
      const found = sections.find((candidate) => candidate.name === 'pinboard');
      if (!found) throw new Error('pinboard section was never registered');
      return found.text();
    },
  };
  return harness;
}
