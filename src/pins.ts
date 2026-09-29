/** Pure pinboard model: durable one-line notes injected into every session's
 * system prompt, newest first under an explicit character budget. A pin is one
 * line — the prompt budget is a hard cap, so overflow stays out of the prompt. */

export interface Pin {
  v: 1;
  id: string;
  text: string;
  at: string;
  source: 'user' | 'agent';
}

export interface PromptBudget {
  /** max pins eligible for injection */
  limit: number;
  /** max characters for the pinned lines themselves (header excluded) */
  maxChars: number;
}

export function nextId(items: Pin[]): string {
  let max = 0;
  for (const item of items) {
    const numeric = Number.parseInt(item.id, 10);
    if (Number.isInteger(numeric) && numeric > max) max = numeric;
  }
  return String(max + 1);
}

export function normalizeText(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

export type AddResult = { kind: 'empty' } | { kind: 'duplicate'; pin: Pin } | { kind: 'added'; pin: Pin; items: Pin[] };

export function addPin(items: Pin[], text: string, source: Pin['source'], at = new Date().toISOString()): AddResult {
  const clean = normalizeText(text);
  if (!clean) return { kind: 'empty' };
  const existing = items.find((item) => item.text === clean);
  if (existing) return { kind: 'duplicate', pin: existing };
  const pin: Pin = { v: 1, id: nextId(items), text: clean, at, source };
  return { kind: 'added', pin, items: [...items, pin] };
}

export function removePin(items: Pin[], id: string): { items: Pin[]; removed: Pin | null } {
  const key = id.replace(/^#/, '').trim();
  const removed = items.find((item) => item.id === key) ?? null;
  if (!removed) return { items, removed: null };
  return { items: items.filter((item) => item.id !== removed.id), removed };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function parseLine(line: string): Pin | null {
  const text = line.trim();
  if (!text) return null;
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return null;
  }
  if (!isRecord(value)) return null;
  if (value.v !== 1) return null;
  if (typeof value.id !== 'string' || typeof value.text !== 'string' || typeof value.at !== 'string') return null;
  if (value.source !== 'user' && value.source !== 'agent') return null;
  if (!Number.isFinite(Date.parse(value.at))) return null;
  return value as unknown as Pin;
}

export function parseLibrary(content: string): { items: Pin[]; skipped: number } {
  const items: Pin[] = [];
  let skipped = 0;
  for (const line of content.split(/\r?\n/)) {
    const pin = parseLine(line);
    if (pin) items.push(pin);
    else if (line.trim()) skipped++;
  }
  return { items, skipped };
}

/** Injection order: freshest first, then id desc as a deterministic tiebreak. */
export function byRecency(items: Pin[]): Pin[] {
  return [...items].sort((a, b) => (a.at === b.at ? Number(b.id) - Number(a.id) : a.at < b.at ? 1 : -1));
}

export function lineFor(pin: Pin): string {
  return `- ${pin.text}`;
}

/** Pins that fit the budget: at most `limit`, and only while the pinned lines
 * stay within `maxChars` (joined with newlines). A single oversized pin is
 * truncated rather than dropped, so the newest note always reaches the prompt. */
export function activePins(items: Pin[], budget: PromptBudget): Pin[] {
  const out: Pin[] = [];
  let used = 0;
  for (const pin of byRecency(items)) {
    if (out.length >= budget.limit) break;
    const remaining = budget.maxChars - used - (out.length ? 1 : 0);
    if (remaining < 3) break;
    const line = lineFor(pin);
    if (line.length <= remaining) {
      out.push(pin);
      used += line.length + (out.length > 1 ? 1 : 0);
      continue;
    }
    if (!out.length) out.push({ ...pin, text: `${pin.text.slice(0, Math.max(0, remaining - 3))}…` });
    break;
  }
  return out;
}

export const SECTION_HEADER = '## 置顶便签（pinboard）';

export function renderSection(items: Pin[], budget: PromptBudget): string {
  const active = activePins(items, budget);
  if (!active.length) return '';
  return [SECTION_HEADER, '用户置顶的持久指令，跨所有会话生效，优先于临时对话中的同类约定：', ...active.map(lineFor)].join('\n');
}

export function usedChars(items: Pin[], budget: PromptBudget): number {
  return activePins(items, budget).reduce((total, pin) => total + lineFor(pin).length + 1, 0);
}

export function renderList(items: Pin[], budget: PromptBudget): string {
  if (!items.length) return '便签板是空的。/pin <一句话> 置顶第一条（会注入每个会话的系统提示）。';
  const activeIds = new Set(activePins(items, budget).map((pin) => pin.id));
  const lines = byRecency(items)
    .slice(0, 30)
    .map((pin) => `  ${activeIds.has(pin.id) ? '●' : '○'} [#${pin.id}] ${pin.text}  (${pin.source} · ${pin.at.slice(0, 10)})`);
  const summary = `置顶便签 ${items.length} 条 · 注入 ${activeIds.size} 条（${usedChars(items, budget)}/${budget.maxChars} 字符，上限 ${budget.limit} 条）`;
  const hint = items.length > activeIds.size ? '\n○ 的便签因超出字符/条数上限未注入——/unpin <id> 清理旧的。' : '';
  return [summary, ...lines].join('\n') + hint;
}
