/**
 * dsh wiring for pinboard: notes pinned once in any session reach every future
 * session through a system-prompt section. The section text is a provider, so
 * pins added mid-run appear on the next assembly without restarting dsh.
 */
import type { Context } from '@deepseek-ai/cordis';
import Schema from '@deepseek-ai/schemastery';
import { addPin, type Pin } from './pins.ts';
export declare const name = "pinboard";
export declare const inject: string[];
export interface Config {
    enabled: boolean;
    dataPath?: string;
    /** how many hits /facts find and fact_search print */
    factLimit: number;
    /** one-time migration source, left untouched */
    factsPath: string;
    limit: number;
    maxChars: number;
    order: number;
}
export declare const Config: Schema<Schemastery.ObjectS<{
    enabled: Schema<boolean, boolean>;
    dataPath: Schema<string, string>;
    factLimit: Schema<number, number>;
    factsPath: Schema<string, string>;
    limit: Schema<number, number>;
    maxChars: Schema<number, number>;
    order: Schema<number, number>;
}>, Schemastery.ObjectT<{
    enabled: Schema<boolean, boolean>;
    dataPath: Schema<string, string>;
    factLimit: Schema<number, number>;
    factsPath: Schema<string, string>;
    limit: Schema<number, number>;
    maxChars: Schema<number, number>;
    order: Schema<number, number>;
}>>;
export declare function expandHome(path: string): string;
export declare const LOCK_TIMEOUT_MS = 400;
export declare const LOCK_STALE_MS = 5000;
export { addPin };
/** Exclusive-create advisory lock. `EEXIST` means someone holds it: spin until
 * the deadline, take over a stale older than LOCK_STALE_MS. Any other open
 * error (and the deadline) degrade to "proceed unlocked" — availability first,
 * a conflicted saved file has its bad lines tolerated by parse. */
export declare function acquireLock(lockPath: string): boolean;
export declare class PinStore {
    readonly path: string;
    /** set by apply() so lock degradation is visible in the plugin log */
    warn?: (message: string) => void;
    constructor(dataPath: string | undefined);
    load(): Pin[];
    save(items: Pin[]): void;
    /** The one write path: load-modify-write under the lock, with a re-read
     * after acquiring it, so each of N concurrent processes keeps its line. */
    mutate(fn: (items: Pin[]) => Pin[]): void;
}
export declare function apply(ctx: Context, config: Config): void;
//# sourceMappingURL=plugin.d.ts.map