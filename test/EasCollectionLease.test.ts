///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
// Unit tests for EasCollectionLease: the in-process lease, and the Redis `SET NX PX` lease against a small fake
// `redis` module (no real Redis is part of this repo's test setup - see PingCommand.test.ts for the same approach).
import { EasCollectionLease } from "../src/EasCollectionLease.js";

const redis = {
    keys: new Map<string, string>(),
    connectFails: false,
    setFails: false,
    evalFails: false,
    setCalls: 0,
    errorHandlers: [] as Array<(err: Error) => void>,
    reset(): void {
        this.errorHandlers = [];
        this.keys.clear();
        this.connectFails = false;
        this.setFails = false;
        this.evalFails = false;
        this.setCalls = 0;
    },
};

vi.mock("redis", () => ({
    createClient: () => ({
        on: (_event: string, handler: (err: Error) => void) => {
            redis.errorHandlers.push(handler);
        },
        connect: async () => {
            if (redis.connectFails) {
                throw new Error("connect refused");
            }
        },
        set: async (key: string, value: string, options: any) => {
            redis.setCalls++;
            if (redis.setFails) {
                throw new Error("connection lost");
            }
            expect(options).toEqual({ condition: "NX", expiration: { type: "PX", value: 1000 } });
            if (redis.keys.has(key)) {
                return null;
            }
            redis.keys.set(key, value);
            return "OK";
        },
        eval: async (_script: string, options: { keys: string[]; arguments: string[] }) => {
            if (redis.evalFails) {
                throw new Error("connection lost");
            }
            if (redis.keys.get(options.keys[0]) === options.arguments[0]) {
                redis.keys.delete(options.keys[0]);
                return 1;
            }
            return 0;
        },
    }),
}));

const tick = (ms: number = 10) => new Promise((resolve) => setTimeout(resolve, ms));

describe("EasCollectionLease Tests", () => {
    afterEach(() => {
        EasCollectionLease.resetSharedState();
        redis.reset();
    });

    it("Serializes holders of the same key in-process, leaves other keys alone, and gives up after waitMs.", async () => {
        const events: string[] = [];
        const first = await EasCollectionLease.acquire("k", { ttlMs: 1000, waitMs: 1000 });
        const other = await EasCollectionLease.acquire("other", { ttlMs: 1000, waitMs: 0 });
        expect(other).toBeDefined();

        const second = EasCollectionLease.acquire("k", { ttlMs: 1000, waitMs: 1000 }).then((release) => {
            events.push("second");
            return release;
        });
        const timedOut = await EasCollectionLease.acquire("k", { ttlMs: 1000, waitMs: 20 });
        expect(timedOut).toBeUndefined();
        expect(events).toEqual([]);

        await first!();
        const release = await second;
        expect(events).toEqual(["second"]);
        await release!();
        await other!();
        // A released key is free again straight away.
        expect(await EasCollectionLease.acquire("k", { ttlMs: 1000, waitMs: 0 })).toBeDefined();
    });

    it("Holds a Redis key across server copies, waiting for another copy's key and releasing only its own token.", async () => {
        const options = { redisUrl: "redis://fake", ttlMs: 1000, waitMs: 200, pollMs: 5 };
        redis.keys.set("eas:lease:k", "another-server-copy");

        const waiting = EasCollectionLease.acquire("k", options);
        await tick(30);
        expect(redis.setCalls).toBeGreaterThan(1);
        redis.keys.delete("eas:lease:k");
        const release = await waiting;
        expect(release).toBeDefined();
        const token = redis.keys.get("eas:lease:k");
        expect(token).toBeDefined();

        await release!();
        expect(redis.keys.has("eas:lease:k")).toBe(false);

        // An expired-and-retaken key isn't deleted by the old holder; a failed release is swallowed.
        const stale = await EasCollectionLease.acquire("k", options);
        redis.keys.set("eas:lease:k", "retaken");
        await stale!();
        expect(redis.keys.get("eas:lease:k")).toBe("retaken");
        redis.keys.clear();
        const failing = await EasCollectionLease.acquire("k", options);
        redis.evalFails = true;
        await expect(failing!()).resolves.toBeUndefined();
    });

    it("Gives up when another copy's Redis key outlives waitMs, freeing the in-process lease again.", async () => {
        redis.keys.set("eas:lease:k", "another-server-copy");

        expect(await EasCollectionLease.acquire("k", { redisUrl: "redis://fake", ttlMs: 1000, waitMs: 30, pollMs: 100 })).toBeUndefined();

        redis.keys.clear();
        expect(await EasCollectionLease.acquire("k", { redisUrl: "redis://fake", ttlMs: 1000, waitMs: 0 })).toBeDefined();
    });

    it("Fails open to the in-process lease when Redis can't be reached, retrying the connection later.", async () => {
        redis.connectFails = true;
        const release = await EasCollectionLease.acquire("k", { redisUrl: "redis://fake", ttlMs: 1000, waitMs: 0 });
        expect(release).toBeDefined();
        expect(await EasCollectionLease.acquire("k", { redisUrl: "redis://fake", ttlMs: 1000, waitMs: 0 })).toBeUndefined();
        await release!();

        redis.connectFails = false;
        redis.setFails = true;
        const afterSetFailure = await EasCollectionLease.acquire("k", { redisUrl: "redis://fake", ttlMs: 1000, waitMs: 0 });
        expect(afterSetFailure).toBeDefined();
        await afterSetFailure!();

        redis.setFails = false;
        const reconnected = await EasCollectionLease.acquire("k", { redisUrl: "redis://fake", ttlMs: 1000, waitMs: 0 });
        expect(redis.keys.has("eas:lease:k")).toBe(true);
        // The shared client's error events (it reconnects on its own) never crash the process.
        expect(() => redis.errorHandlers.forEach((handler) => handler(new Error("socket closed")))).not.toThrow();
        expect(redis.errorHandlers.length).toBeGreaterThan(0);
        await reconnected!();
    });
});
