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
    /** optional expiry (ISO). Optional-in-v1: lines written before expiry existed
     * simply lack the key, and a malformed stamp only loses the expiry. */
    expiresAt?: string;
}
export declare function isFact(pin: Pin): boolean;
export declare function pinsOfKind(items: Pin[], kind: PinKind): Pin[];
/** `一句话正文 #标签 #另一个` — fact-vault's tag syntax, kept identical so an
 * imported fact reads the same way it did before. */
export declare function parseTags(raw: string): {
    text: string;
    tags: string[];
};
/** `~7d` / `~12h` / `~2w` anywhere in the input sets an expiry. The `~` prefix
 * is deliberate: `#` already means tags (facts syntax), and a bare `7d` would
 * eat real note text. */
export declare function parseExpiry(raw: string, now?: Date): {
    text: string;
    expiresAt?: string;
};
/** Full /pin input: expiry token first, then tags. */
export declare function parsePinInput(raw: string, now?: Date): {
    text: string;
    tags: string[];
    expiresAt?: string | undefined;
};
/** An expired pin stops being injected the moment the clock passes its stamp. */
export declare function isExpired(pin: Pin, now?: Date): boolean;
/** 临期 = inside its last 24 hours (or already past, for display). */
export declare function isExpiringSoon(pin: Pin, now?: Date, withinMs?: number): boolean;
export interface PromptBudget {
    /** max pins eligible for injection */
    limit: number;
    /** max characters for the pinned lines themselves (header excluded) */
    maxChars: number;
}
export declare function nextId(items: Pin[]): string;
export declare function normalizeText(text: string): string;
export type AddResult = {
    kind: 'empty';
} | {
    kind: 'duplicate';
    pin: Pin;
} | {
    kind: 'added';
    pin: Pin;
    items: Pin[];
};
/** Facts and pins share the library but not the dedup space: the same sentence
 * may legitimately be both a standing instruction and a stored fact. */
export declare function addPin(items: Pin[], text: string, source: Pin['source'], at?: string, extra?: {
    kind?: PinKind;
    tags?: string[] | undefined;
    expiresAt?: string | undefined;
}): AddResult;
export declare function removePin(items: Pin[], id: string): {
    items: Pin[];
    removed: Pin | null;
};
export declare function parseLine(line: string): Pin | null;
export declare function parseLibrary(content: string): {
    items: Pin[];
    skipped: number;
};
/** Injection order: freshest first, then id desc as a deterministic tiebreak. */
export declare function byRecency(items: Pin[]): Pin[];
export declare function lineFor(pin: Pin): string;
/** Pins that fit the budget: at most `limit`, and only while the pinned lines
 * stay within `maxChars` (joined with newlines). A single oversized pin is
 * truncated rather than dropped, so the newest note always reaches the prompt.
 * Expired pins never inject — the clock, not the budget, decides those. */
export declare function activePins(items: Pin[], budget: PromptBudget, now?: Date): Pin[];
export declare const SECTION_HEADER = "## \u7F6E\u9876\u4FBF\u7B7E\uFF08pinboard\uFF09";
export declare function renderSection(items: Pin[], budget: PromptBudget): string;
export declare function usedChars(items: Pin[], budget: PromptBudget, now?: Date): number;
export declare function tagSuffix(pin: Pin): string;
/** /pins display suffix: what expires when, with a mark when it already has or
 * is about to (last 24h). Pins without expiry say nothing. */
export declare function expiryMark(pin: Pin, now?: Date): string;
export declare function renderList(items: Pin[], budget: PromptBudget, now?: Date): string;
export interface ScoredPin {
    pin: Pin;
    score: number;
}
/** fact-vault's matcher, kept term for term: lowercase, whitespace-split, tag hit
 * worth 3 and text hit worth 1, OR across terms, best score first then newest. */
export declare function findFacts(items: Pin[], query: string, kind?: PinKind): ScoredPin[];
export declare function renderFound(scored: ScoredPin[], limit: number): string;
/** One-time migration from dsh-plugin-fact-vault's facts.jsonl shape. */
export interface ImportRow {
    text: string;
    tags?: string[] | undefined;
    at?: string | undefined;
}
export declare function importFacts(items: Pin[], rows: ImportRow[], now?: string): {
    items: Pin[];
    added: number;
    duplicates: number;
    skipped: number;
};
//# sourceMappingURL=pins.d.ts.map