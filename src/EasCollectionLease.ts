///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import * as crypto from "crypto";
import { createClient, type RedisClientType } from "redis";

/** Releases an acquired lease. Never throws. */
export type LeaseRelease = () => Promise<void>;

export interface LeaseOptions {
    /** Redis to hold the lease in across server copies (`datastores:cache`); in-process only without it. */
    redisUrl?: string;
    /** How long a Redis lease lives if its holder never releases it (a crashed server copy). */
    ttlMs: number;
    /** How long to wait for a held lease before giving up. */
    waitMs: number;
    /** Delay between Redis acquisition attempts. */
    pollMs?: number;
}

/** Deletes the lease key only while it still carries this holder's token, so an expired-and-retaken lease survives. */
const RELEASE_SCRIPT = 'if redis.call("get", KEYS[1]) == ARGV[1] then return redis.call("del", KEYS[1]) else return 0 end';

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * A short exclusive lease on one key - `SyncCommand` holds one per (mailbox, device, folder) for the duration of a
 * collection's round, so two concurrent `Sync`s of the same collection (a client retrying while its first request is
 * still running, or two server copies) can't both read the same state, apply their commands and overwrite each
 * other's result.
 *
 * Always taken in-process first (a per-key promise chain), then - when a Redis URL is configured - as a `SET NX PX`
 * key shared by every server copy, released with a token check. Redis being unreachable fails open to the
 * in-process lease alone rather than refusing every `Sync`.
 *
 * @author Jean-Philippe Steinmetz
 */
export class EasCollectionLease {
    /** The in-process holder of each key: resolves once that holder releases. */
    private static readonly local: Map<string, Promise<void>> = new Map();
    /** Shared command clients, keyed by Redis URL. */
    private static readonly clients: Map<string, Promise<RedisClientType>> = new Map();

    /** Forgets all process-wide state. Intended for tests. */
    public static resetSharedState(): void {
        EasCollectionLease.local.clear();
        EasCollectionLease.clients.clear();
    }

    private static getClient(url: string): Promise<RedisClientType> {
        let pending = EasCollectionLease.clients.get(url);
        if (!pending) {
            const client = createClient({ url }) as RedisClientType;
            // An unhandled `error` event would crash the process; the client reconnects on its own.
            client.on("error", () => undefined);
            const connecting: Promise<RedisClientType> = client.connect().then(() => client);
            connecting.catch(() => {
                if (EasCollectionLease.clients.get(url) === connecting) {
                    EasCollectionLease.clients.delete(url);
                }
            });
            EasCollectionLease.clients.set(url, connecting);
            pending = connecting;
        }
        return pending;
    }

    /** Waits for `key`'s in-process holder (if any) to release, up to `deadline`, then takes it over with `held` - the
     * check and the take-over happen in the same tick, so two waiters can never both find the key free. `false` on
     * timeout. */
    private static async takeLocal(key: string, held: Promise<void>, deadline: number): Promise<boolean> {
        for (;;) {
            const holder = EasCollectionLease.local.get(key);
            if (!holder) {
                EasCollectionLease.local.set(key, held);
                return true;
            }
            const remaining = deadline - Date.now();
            if (remaining <= 0) {
                return false;
            }
            let timer: NodeJS.Timeout | undefined;
            await Promise.race([holder, new Promise<void>((resolve) => (timer = setTimeout(resolve, remaining)))]);
            clearTimeout(timer);
        }
    }

    /**
     * Acquires the lease on `key`, waiting up to `options.waitMs` for a current holder. Resolves with the release
     * function, or `undefined` when the lease couldn't be acquired in time.
     */
    public static async acquire(key: string, options: LeaseOptions): Promise<LeaseRelease | undefined> {
        const deadline: number = Date.now() + options.waitMs;
        let resolveLocal!: () => void;
        const held = new Promise<void>((resolve) => (resolveLocal = resolve));
        if (!(await EasCollectionLease.takeLocal(key, held, deadline))) {
            return undefined;
        }
        const releaseLocal = (): void => {
            if (EasCollectionLease.local.get(key) === held) {
                EasCollectionLease.local.delete(key);
            }
            resolveLocal();
        };

        if (!options.redisUrl) {
            return async () => releaseLocal();
        }

        const redisKey = `eas:lease:${key}`;
        const token: string = crypto.randomUUID();
        let client: RedisClientType;
        try {
            client = await EasCollectionLease.getClient(options.redisUrl);
            for (;;) {
                const reply = await client.set(redisKey, token, { condition: "NX", expiration: { type: "PX", value: options.ttlMs } });
                if (reply === "OK") {
                    break;
                }
                if (Date.now() >= deadline) {
                    releaseLocal();
                    return undefined;
                }
                await sleep(Math.min(options.pollMs ?? 100, Math.max(1, deadline - Date.now())));
            }
        } catch {
            // Redis unreachable: fail open to the in-process lease.
            return async () => releaseLocal();
        }

        return async () => {
            try {
                await client.eval(RELEASE_SCRIPT, { keys: [redisKey], arguments: [token] });
            } catch {
                // The key expires on its own.
            }
            releaseLocal();
        };
    }
}
