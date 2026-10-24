import Schema from '@deepseek-ai/schemastery';
import { defineTool } from '@deepseek-ai/dsh-tools';
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { addPin, activePins, findFacts, importFacts, isFact, parseLibrary, parsePinInput, parseTags, pinsOfKind, removePin, renderFound, renderList, renderSection, tagSuffix, } from './pins.js';
export const name = 'pinboard';
export const inject = ['commands', 'tools', 'systemPrompt'];
export const Config = Schema.object({
    enabled: Schema.boolean().default(true),
    dataPath: Schema.string(),
    factLimit: Schema.natural().default(10),
    factsPath: Schema.string().default('~/.dsh/fact-vault/facts.jsonl'),
    limit: Schema.natural().default(12),
    maxChars: Schema.natural().default(1200),
    order: Schema.number().default(700),
});
export function expandHome(path) {
    return path.startsWith('~') ? join(homedir(), path.slice(1)) : path;
}
export const LOCK_TIMEOUT_MS = 400;
export const LOCK_STALE_MS = 5000;
export { addPin };
/** Exclusive-create advisory lock. `EEXIST` means someone holds it: spin until
 * the deadline, take over a stale older than LOCK_STALE_MS. Any other open
 * error (and the deadline) degrade to "proceed unlocked" — availability first,
 * a conflicted saved file has its bad lines tolerated by parse. */
export function acquireLock(lockPath) {
    const deadline = Date.now() + LOCK_TIMEOUT_MS;
    for (;;) {
        try {
            closeSync(openSync(lockPath, 'wx'));
            return true;
        }
        catch (error) {
            if (error.code !== 'EEXIST')
                return true;
            if (Date.now() >= deadline)
                return false;
            try {
                if (Date.now() - statSync(lockPath).mtimeMs > LOCK_STALE_MS)
                    unlinkSync(lockPath);
            }
            catch {
                // vanished or lost the takeover race — retry the create instead
            }
            Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
        }
    }
}
function releaseLock(lockPath) {
    try {
        unlinkSync(lockPath);
    }
    catch {
        // a stale-lock taker who lost the re-create race removes nothing
    }
}
export class PinStore {
    path;
    /** set by apply() so lock degradation is visible in the plugin log */
    warn;
    constructor(dataPath) {
        this.path = dataPath ? expandHome(dataPath) : join(homedir(), '.dsh', 'pinboard', 'pins.jsonl');
    }
    load() {
        if (!existsSync(this.path))
            return [];
        return parseLibrary(readFileSync(this.path, 'utf8')).items;
    }
    save(items) {
        mkdirSync(dirname(this.path), { recursive: true });
        // temp+rename: concurrent readers and a crash mid-write never see a torn file
        const tmp = join(dirname(this.path), `.pins-${process.pid}-${Date.now()}.tmp`);
        writeFileSync(tmp, items.map((item) => JSON.stringify(item)).join('\n') + '\n', 'utf8');
        renameSync(tmp, this.path);
    }
    /** The one write path: load-modify-write under the lock, with a re-read
     * after acquiring it, so each of N concurrent processes keeps its line. */
    mutate(fn) {
        mkdirSync(dirname(this.path), { recursive: true });
        const lockPath = `${this.path}.lock`;
        const locked = acquireLock(lockPath);
        if (!locked)
            this.warn?.('pinboard lock busy — saved without lock');
        try {
            this.save(fn(this.load()));
        }
        finally {
            if (locked)
                releaseLock(lockPath);
        }
    }
}
export function apply(ctx, config) {
    const log = ctx.logger('pinboard');
    if (!config.enabled)
        return void log.info('disabled by config');
    if (!Number.isFinite(config.order))
        throw new TypeError('pinboard: order must be a finite number');
    if (!Number.isInteger(config.factLimit) || config.factLimit < 1)
        throw new TypeError('pinboard: factLimit must be a positive integer');
    if (typeof config.factsPath !== 'string' || !config.factsPath.trim())
        throw new TypeError('pinboard: factsPath must be a non-empty string');
    const store = new PinStore(config.dataPath);
    store.warn = (message) => log.warn(message);
    const budget = { limit: config.limit, maxChars: config.maxChars };
    const add = (raw, source, kind = 'pin') => {
        let result;
        store.mutate((items) => {
            const parsed = parsePinInput(raw);
            result = addPin(items, parsed.text, source, undefined, { kind, tags: parsed.tags, expiresAt: parsed.expiresAt });
            return result.kind === 'added' ? result.items : items;
        });
        return result;
    };
    const label = (pin) => `[#${pin.id}] ${pin.text}${tagSuffix(pin)}`;
    ctx.systemPrompt.section({
        name: 'pinboard',
        order: config.order,
        text: () => {
            try {
                return renderSection(store.load(), budget);
            }
            catch (error) {
                log.warn(`pinboard section skipped: ${String(error)}`);
                return '';
            }
        },
    });
    ctx.commands.register({
        name: 'pin',
        description: '置顶一条便签，注入之后每个会话的系统提示：/pin <一句话> [#标签…] [~时长]（~7d/~12h/~2w 设过期，过期自动停止注入）',
        input: { hint: '<一句话> [#标签…] [~7d]' },
        handler: ({ rawInput }) => {
            const result = add(String(rawInput ?? ''), 'user');
            if (result.kind === 'empty')
                return { kind: 'error', text: '便签内容为空。用法：/pin <一句话> [#标签…] [~7d]' };
            if (result.kind === 'duplicate')
                return { kind: 'success', text: `已经置顶过了：${label(result.pin)}` };
            const expiry = result.pin.expiresAt ? `，过期时间 ${result.pin.expiresAt.slice(0, 16).replace('T', ' ')}` : '';
            return { kind: 'success', text: `已置顶 ${label(result.pin)}（下一个回合起注入系统提示${expiry}；/pins 查看，/unpin ${result.pin.id} 取消）` };
        },
    });
    ctx.commands.register({
        name: 'unpin',
        description: '取消置顶：/unpin <id>',
        input: { hint: '<id>' },
        handler: ({ rawInput }) => {
            const id = String(rawInput ?? '').trim();
            if (!id)
                return { kind: 'error', text: '用法：/unpin <id>（id 见 /pins）' };
            let removed = null;
            store.mutate((items) => {
                const { items: kept, removed: hit } = removePin(items, id);
                removed = hit;
                return kept;
            });
            if (!removed)
                return { kind: 'error', text: `没有 [#${id}]，/pins 看现有便签` };
            return { kind: 'success', text: `已取消 ${label(removed)}` };
        },
    });
    ctx.commands.register({
        name: 'pins',
        description: '列出置顶便签并标出哪些真的注入了系统提示',
        handler: () => {
            let skipped = 0;
            if (existsSync(store.path))
                skipped = parseLibrary(readFileSync(store.path, 'utf8')).skipped;
            const text = renderList(store.load(), budget);
            return { kind: 'success', text: skipped ? `${text}\n⚠ ${skipped} 行损坏被跳过` : text };
        },
    });
    /** The fact-vault surface, merged: same verbs, same tag syntax, same scoring —
     * but stored with the pins and reachable from the search tool. */
    ctx.commands.register({
        name: 'facts',
        description: '事实库（存下来供检索，**不注入**系统提示）：/facts save <事实 [#标签]> | find <关键词> | list | rm <id> | import [--from <路径>]',
        input: { hint: '<save|find|list|rm|import> …' },
        handler: ({ rawInput }) => {
            const raw = String(rawInput ?? '').trim();
            const [verb = '', ...rest] = raw.split(/\s+/);
            const items = store.load();
            if (!verb || verb === 'list') {
                const facts = pinsOfKind(items, 'fact');
                if (!facts.length)
                    return { kind: 'success', text: '事实库是空的。/facts save <事实 [#标签]> 存第一条；旧 dsh-plugin-fact-vault 的数据用 /facts import 一次搬过来。' };
                const lines = [...facts]
                    .sort((a, b) => (a.at < b.at ? 1 : -1))
                    .slice(0, 20)
                    .map((pin) => `  ${label(pin)}  (${pin.at.slice(0, 10)})`);
                return { kind: 'success', text: [`事实库 ${facts.length} 条（不注入系统提示，靠 /facts find 或 fact_search 取用）：`, ...lines].join('\n') };
            }
            if (verb === 'save') {
                const result = add(rest.join(' '), 'user', 'fact');
                if (result.kind === 'empty')
                    return { kind: 'error', text: '内容为空。用法：/facts save <事实 [#标签]>' };
                if (result.kind === 'duplicate')
                    return { kind: 'success', text: `事实库里已有 ${label(result.pin)}` };
                const hintTag = result.pin.tags?.length ? ` /facts find ${result.pin.tags[0]}` : ' /facts find <关键词>';
                return { kind: 'success', text: `已存入事实库 ${label(result.pin)}（不注入系统提示；${hintTag} 取用）` };
            }
            if (verb === 'find') {
                const query = rest.join(' ');
                if (!query)
                    return { kind: 'error', text: '用法：/facts find <关键词>（多个词取命中之和：标签命中 3 分、正文命中 1 分）' };
                return { kind: 'success', text: renderFound(findFacts(items, query), config.factLimit) };
            }
            if (verb === 'rm') {
                const id = rest[0] ?? '';
                if (!id)
                    return { kind: 'error', text: '用法：/facts rm <id>（id 见 /facts list）' };
                let target;
                store.mutate((items) => {
                    target = items.find((pin) => pin.id === id.replace(/^#/, '') && isFact(pin));
                    return target ? removePin(items, target.id).items : items;
                });
                if (!target)
                    return { kind: 'error', text: `事实库里没有 #${id}（便签请用 /unpin）` };
                return { kind: 'success', text: `已从事实库删除 ${label(target)}` };
            }
            if (verb === 'import') {
                const from = /--from[\s=]+(\S+)/.exec(raw)?.[1];
                const source = expandHome(from ?? config.factsPath);
                if (!existsSync(source)) {
                    return { kind: 'error', text: `找不到 ${source}。要么没装过 dsh-plugin-fact-vault，要么 /facts import --from <路径> 指一下。` };
                }
                const rows = [];
                let broken = 0;
                for (const line of readFileSync(source, 'utf8').split(/\r?\n/)) {
                    if (!line.trim())
                        continue;
                    try {
                        const value = JSON.parse(line);
                        if (typeof value?.text !== 'string' || !value.text.trim()) {
                            broken++;
                            continue;
                        }
                        rows.push({
                            text: value.text,
                            tags: Array.isArray(value.tags) ? value.tags.filter((tag) => typeof tag === 'string') : undefined,
                            at: typeof value.at === 'string' && Number.isFinite(Date.parse(value.at)) ? value.at : undefined,
                        });
                    }
                    catch {
                        broken++;
                    }
                }
                let merged;
                store.mutate((items) => {
                    merged = importFacts(items, rows);
                    return merged.items;
                });
                return {
                    kind: 'success',
                    text: `从 ${source} 导入：新增 ${merged.added} 条 · 重复跳过 ${merged.duplicates} 条 · 坏行 ${broken + merged.skipped} 条。` +
                        `事实库现在 ${pinsOfKind(merged.items, 'fact').length} 条。**源文件没动**——核对无误后再停用 dsh-plugin-fact-vault。`,
                };
            }
            return { kind: 'error', text: `不认识的动作「${verb}」。可用：save / find / list / rm / import` };
        },
    });
    ctx.tools.register(defineTool({
        name: 'pin_add',
        description: '把一条长期有效的约定置顶，之后每个会话的系统提示都会带上它。只在用户明确要求"记住/以后都"时使用。',
        parameters: {
            text: { type: 'string', required: true, description: '一句话，会压成单行存储' },
        },
        output: {
            schema: { type: 'string' },
            render: (_args, value) => [{ type: 'text', text: value }],
        },
        presentCall: () => ({ card: 'generic', title: '置顶便签', kind: 'edit' }),
        presentResult: (_args, value) => ({
            card: 'generic',
            title: String(value).split('\n')[0].slice(0, 60),
            kind: 'edit',
            rawInput: value,
        }),
        async execute(args) {
            const result = add(args.text, 'agent');
            if (result.kind === 'empty')
                return '内容为空，未置顶。';
            if (result.kind === 'duplicate')
                return `已存在 [#${result.pin.id}]：${result.pin.text}`;
            const injected = activePins(store.load(), budget).some((pin) => pin.id === result.pin.id);
            return `已置顶 [#${result.pin.id}] ${result.pin.text}${injected ? '' : '（超出预算，暂不会注入系统提示——/pins 查看）'}`;
        },
    }));
    ctx.tools.register(defineTool({
        name: 'fact_search',
        description: '在事实库里按关键词/标签检索已存下的事实（标签命中 3 分、正文命中 1 分）。回答"我们之前定过/查过 X 吗"之前先用它，不要凭记忆答。',
        parameters: {
            query: { type: 'string', required: true, description: '一个或多个关键词，可带 #标签' },
        },
        output: {
            schema: { type: 'string' },
            render: (_args, value) => [{ type: 'text', text: value }],
        },
        presentCall: () => ({ card: 'generic', title: '搜事实库', kind: 'search' }),
        presentResult: (_args, value) => ({
            card: 'generic',
            title: String(value).split('\n')[0].slice(0, 60),
            kind: 'search',
            rawInput: value,
        }),
        async execute(args) {
            const parsed = parseTags(String(args.query ?? ''));
            return renderFound(findFacts(store.load(), [...parsed.tags, ...parsed.text.split(/\s+/)].join(' ')), config.factLimit);
        },
    }));
    log.info(`mounted · ${store.path} · limit=${config.limit} maxChars=${config.maxChars} order=${config.order}`);
}
//# sourceMappingURL=plugin.js.map