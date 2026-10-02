/** Pure pinboard model: durable one-line notes injected into every session's
 * system prompt, newest first under an explicit character budget. A pin is one
 * line — the prompt budget is a hard cap, so overflow stays out of the prompt. */

export type PinKind = 'pin' | 'fact';

export interface Pin {
  v: 1;
  id: string;
  text: string;
  at: string;
  source: 'user' | 'agent';
  /** absent means 'pin'. A 'fact' shares the library but is never auto-injected
   * — it is found on demand. That consumer is what fact-vault lacked. */
  kind?: PinKind;
  tags?: string[];
}

export function isFact(pin: Pin): boolean {
  return pin.kind === 'fact';
}

export function pinsOfKind(items: Pin[], kind: PinKind): Pin[] {
  return items.filter((item) => (item.kind ?? 'pin') === kind);
}

/** `一句话正文 #标签 #另一个` — fact-vault's tag syntax, kept identical so an
 * imported fact reads the same way it did before. */
export function parseTags(raw: string): { text: string; tags: string[] } {
  const tags: string[] = [];
  const words: string[] = [];
  for (const token of String(raw ?? '').split(/\s+/).filter(Boolean)) {
    if (token.startsWith('#') && token.length > 1) tags.push(token.slice(1).toLowerCase());
    else words.push(token);
  }
  return { text: normalizeText(words.join(' ')), tags: [...new Set(tags)] };
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

/** Facts and pins share the library but not the dedup space: the same sentence
 * may legitimately be both a standing instruction and a stored fact. */
export function addPin(items: Pin[], text: string, source: Pin['source'], at = new Date().toISOString(), extra: { kind?: PinKind; tags?: string[] } = {}): AddResult {
  const clean = normalizeText(text);
  if (!clean) return { kind: 'empty' };
  const kind: PinKind = extra.kind ?? 'pin';
  const existing = items.find((item) => item.text === clean && (item.kind ?? 'pin') === kind);
  if (existing) return { kind: 'duplicate', pin: existing };
  const tags = [...new Set((extra.tags ?? []).map((tag) => tag.toLowerCase()).filter(Boolean))];
  const pin: Pin = { v: 1, id: nextId(items), text: clean, at, source, ...(kind === 'fact' ? { kind } : {}), ...(tags.length ? { tags } : {}) };
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
  // kind decides whether a line reaches the prompt, so a bogus one is not guessable.
  if (value.kind !== undefined && value.kind !== 'pin' && value.kind !== 'fact') return null;
  const pin = value as unknown as Pin;
  // malformed tags only lose the tags; the note itself is still worth keeping.
  if (pin.tags !== undefined && (!Array.isArray(pin.tags) || !pin.tags.every((tag) => typeof tag === 'string'))) delete pin.tags;
  return pin;
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
  for (const pin of byRecency(pinsOfKind(items, 'pin'))) {
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

export function tagSuffix(pin: Pin): string {
  return pin.tags?.length ? `  #${pin.tags.join(' #')}` : '';
}

export function renderList(items: Pin[], budget: PromptBudget): string {
  const pins = pinsOfKind(items, 'pin');
  const facts = pinsOfKind(items, 'fact');
  if (!items.length) return '便签板是空的。/pin <一句话> 置顶第一条（会注入每个会话的系统提示）；/facts save <事实 #标签> 存进事实库（不注入，用 /facts find 查）。';
  const activeIds = new Set(activePins(items, budget).map((pin) => pin.id));
  const lines = byRecency(items)
    .slice(0, 30)
    .map((pin) => `  ${isFact(pin) ? '◆' : activeIds.has(pin.id) ? '●' : '○'} [#${pin.id}] ${pin.text}${tagSuffix(pin)}  (${pin.source} · ${pin.at.slice(0, 10)})`);
  const summary = `便签 ${pins.length} 条（注入 ${activeIds.size} 条，${usedChars(items, budget)}/${budget.maxChars} 字符，上限 ${budget.limit} 条）· 事实库 ${facts.length} 条（不注入）`;
  const hint = pins.length > activeIds.size ? '\n○ 的便签因超出字符/条数上限未注入——/unpin <id> 清理旧的。' : '';
  return [summary, ...lines].join('\n') + hint;
}

export interface ScoredPin {
  pin: Pin;
  score: number;
}

/** fact-vault's matcher, kept term for term: lowercase, whitespace-split, tag hit
 * worth 3 and text hit worth 1, OR across terms, best score first then newest. */
export function findFacts(items: Pin[], query: string, kind: PinKind = 'fact'): ScoredPin[] {
  const terms = [...new Set(String(query ?? '').toLowerCase().split(/\s+/).filter(Boolean))];
  if (!terms.length) return [];
  const scored: ScoredPin[] = [];
  for (const pin of items) {
    if ((pin.kind ?? 'pin') !== kind) continue;
    const tags = (pin.tags ?? []).map((tag) => tag.toLowerCase());
    const haystack = pin.text.toLowerCase();
    let score = 0;
    for (const term of terms) {
      if (tags.includes(term)) score += 3;
      else if (haystack.includes(term)) score += 1;
    }
    if (score > 0) scored.push({ pin, score });
  }
  return scored.sort((a, b) => b.score - a.score || (a.pin.at < b.pin.at ? 1 : -1));
}

export function renderFound(scored: ScoredPin[], limit: number): string {
  if (!scored.length) return '事实库里没有匹配项。/facts list 看有什么，/facts save <事实 #标签> 存一条。';
  const head = `命中 ${scored.length} 条（显示前 ${Math.min(limit, scored.length)}）:`;
  const lines = scored.slice(0, limit).map((entry) => `  [#${entry.pin.id}] 分${entry.score} ${entry.pin.text}${tagSuffix(entry.pin)}`);
  return [head, ...lines, scored.length > limit ? `…还有 ${scored.length - limit} 条，用更专的关键词。` : ''].filter(Boolean).join('\n');
}

/** One-time migration from dsh-plugin-fact-vault's facts.jsonl shape. */
export interface ImportRow {
  text: string;
  tags?: string[];
  at?: string;
}

export function importFacts(items: Pin[], rows: ImportRow[], now = new Date().toISOString()): { items: Pin[]; added: number; duplicates: number; skipped: number } {
  let working = items;
  let added = 0;
  let duplicates = 0;
  let skipped = 0;
  for (const row of rows) {
    if (typeof row?.text !== 'string' || !row.text.trim()) {
      skipped++;
      continue;
    }
    const result = addPin(working, row.text, 'user', row.at && Number.isFinite(Date.parse(row.at)) ? row.at : now, { kind: 'fact', tags: row.tags });
    if (result.kind === 'added') {
      working = result.items;
      added++;
    } else if (result.kind === 'duplicate') duplicates++;
    else skipped++;
  }
  return { items: working, added, duplicates, skipped };
}
