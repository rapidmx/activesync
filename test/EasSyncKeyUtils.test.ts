///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
// Direct unit tests for EasSyncKeyUtils's pure logic (no DI/DB dependency) - matches this project's convention
// of testing pure binary/data-format logic (see test/eas/codec/WbxmlCodec.test.ts) directly, rather than only
// indirectly through a real server round trip. `computeChanges()`'s merge/sort/windowing logic is exercised
// here against a hand-built fake repo so its comparator actually runs across more than one pair of rows -
// something the existing FolderSync integration tests never produce because each real test round only ever
// creates a single change of any one kind.
import { ApiError } from "@rapidrest/core";
import { ApiErrors } from "@rapidrest/service-core";
import {
    compareCursor,
    computeChanges,
    epochCursor,
    formatSyncKey,
    parseSyncKey,
    persistDeviceSyncState,
    resolveSyncKey,
    scanAfter,
} from "../src/EasSyncKeyUtils.js";

describe("EasSyncKeyUtils Tests", () => {
    describe("formatSyncKey/parseSyncKey", () => {
        it("Round-trips a SyncKey through format then parse.", () => {
            const watermark = new Date("2026-09-04T12:00:00.000Z");
            const formatted = formatSyncKey({ generation: 3, watermark });
            expect(parseSyncKey(formatted)).toEqual({ generation: 3, watermark });
        });

        it("Returns undefined for a value with no ':' separator.", () => {
            expect(parseSyncKey("not-a-valid-key")).toBeUndefined();
        });

        it("Returns undefined for a value with a non-numeric generation or unparseable date.", () => {
            expect(parseSyncKey("abc:2026-09-04T12:00:00.000Z")).toBeUndefined();
            expect(parseSyncKey("3:not-a-date")).toBeUndefined();
        });
    });

    describe("resolveSyncKey", () => {
        it("Treats '0' and missing/empty client values as 'initial' regardless of storedValue.", () => {
            expect(resolveSyncKey("0", "1:2026-09-04T12:00:00.000Z")).toEqual({ kind: "initial" });
            expect(resolveSyncKey(undefined, "1:2026-09-04T12:00:00.000Z")).toEqual({ kind: "initial" });
            expect(resolveSyncKey("", undefined)).toEqual({ kind: "initial" });
        });

        it("Treats a client value with no matching storedValue as 'invalid'.", () => {
            expect(resolveSyncKey("1:2026-09-04T12:00:00.000Z", undefined)).toEqual({ kind: "invalid" });
        });

        it("Treats a client value that doesn't exactly match storedValue as 'invalid'.", () => {
            expect(resolveSyncKey("1:2026-09-04T12:00:00.000Z", "2:2026-09-04T12:00:00.000Z")).toEqual({
                kind: "invalid",
            });
        });

        it("Treats an exact match against a corrupted/malformed storedValue as 'invalid', not a crash.", () => {
            // Models the (client and stored value happen to match, but the stored value itself is not a
            // well-formed SyncKey) case - only reachable if persisted state was corrupted, since this library
            // only ever stores keys it itself minted via formatSyncKey().
            expect(resolveSyncKey("not-a-valid-key", "not-a-valid-key")).toEqual({ kind: "invalid" });
        });

        it("Treats an exact match against storedValue as 'valid'.", () => {
            const stored = "2:2026-09-04T12:00:00.000Z";
            expect(resolveSyncKey(stored, stored)).toEqual({
                kind: "valid",
                key: { generation: 2, watermark: new Date("2026-09-04T12:00:00.000Z") },
            });
        });
    });

    describe("persistDeviceSyncState", () => {
        // `update`'s mock captures a *shallow copy* of its arguments at call time, not the live references -
        // `deviceSyncState` is the same object throughout this function (mutated again after the awaited call
        // resolves), so asserting against `vi.fn()`'s recorded call args directly would observe the object's
        // *final* state instead of what was actually sent on the wire at call time.
        function capturingUpdate(result: any): { update: any; calls: { query: any; existing: any }[] } {
            const calls: { query: any; existing: any }[] = [];
            const update = vi.fn().mockImplementation(async (query: any, existing: any) => {
                calls.push({ query: { ...query }, existing: { ...existing } });
                return result;
            });
            return { update, calls };
        }

        it("Applies the patch to the in-memory object and pulls the repo's returned version back onto it.", async () => {
            // Models RepoUtils.update()'s real contract: it never mutates its `existing` argument, it only
            // returns a freshly-fetched instance reflecting the write (with `version` bumped) - see this
            // function's own doc comment for why blindly discarding that return value is the bug being fixed.
            const deviceSyncState: any = { uid: "dss-1", version: 1, provisioned: false };
            const { update, calls } = capturingUpdate({ uid: "dss-1", version: 2, provisioned: true });
            const repo: any = { update };

            await persistDeviceSyncState(deviceSyncState, repo, { provisioned: true });

            expect(update).toHaveBeenCalledTimes(1);
            expect(calls[0].query).toEqual({ uid: "dss-1", version: 1, provisioned: true });
            expect(calls[0].existing).toEqual({ uid: "dss-1", version: 1, provisioned: true });
            expect(update.mock.calls[0][2]).toEqual({ ignoreACL: true, skipPush: true });
            expect(deviceSyncState).toEqual({ uid: "dss-1", version: 2, provisioned: true });
        });

        it("Keeps the patch applied even when the repo call resolves undefined (e.g. a bare test double).", async () => {
            const deviceSyncState: any = { uid: "dss-1", version: 1, provisioned: false };
            const repo: any = { update: vi.fn().mockResolvedValue(undefined) };

            await persistDeviceSyncState(deviceSyncState, repo, { provisioned: true });

            expect(deviceSyncState).toEqual({ uid: "dss-1", version: 1, provisioned: true });
        });

        it("Lets a second call in the same request build its patch off the version the first call returned.", async () => {
            const deviceSyncState: any = { uid: "dss-1", version: 1 };
            const calls: { query: any; existing: any }[] = [];
            const results = [
                { uid: "dss-1", version: 2, a: "first" },
                { uid: "dss-1", version: 3, a: "first", b: "second" },
            ];
            const update = vi.fn().mockImplementation(async (query: any, existing: any) => {
                calls.push({ query: { ...query }, existing: { ...existing } });
                return results[calls.length - 1];
            });
            const repo: any = { update };

            await persistDeviceSyncState(deviceSyncState, repo, { a: "first" });
            await persistDeviceSyncState(deviceSyncState, repo, { b: "second" });

            // The second call's query must carry version 2 (what the first call left on deviceSyncState), not
            // the original stale version 1 - this is exactly the scenario that silently no-oped before the fix.
            expect(calls[1].query).toEqual({ uid: "dss-1", version: 2, b: "second" });
            expect(calls[1].existing).toEqual({ uid: "dss-1", version: 2, a: "first", b: "second" });
        });
    });

    describe("persistDeviceSyncState concurrency", () => {
        const conflict = () => new ApiError(ApiErrors.INVALID_OBJECT_VERSION, 409, "Version conflict");

        it("Re-reads the row and re-applies a function patch on top of it after losing an optimistic-lock race.", async () => {
            const deviceSyncState: any = { uid: "dss-1", version: 1, folderSyncKeys: { a: "1" } };
            const sent: any[] = [];
            const update = vi.fn().mockImplementation(async (query: any) => {
                sent.push({ ...query });
                if (sent.length === 1) {
                    throw conflict();
                }
                return { ...query, version: query.version + 1 };
            });
            // Another request wrote folder "b"'s key (and bumped the version) in between.
            const findOne = vi.fn().mockResolvedValue({ uid: "dss-1", version: 2, folderSyncKeys: { a: "1", b: "2" } });

            await persistDeviceSyncState(deviceSyncState, { update, findOne } as any, (current) => ({
                folderSyncKeys: { ...current.folderSyncKeys, c: "3" },
            }));

            expect(update).toHaveBeenCalledTimes(2);
            expect(sent[1]).toEqual({ uid: "dss-1", version: 2, folderSyncKeys: { a: "1", b: "2", c: "3" } });
            expect(deviceSyncState.version).toBe(3);
        });

        it("Gives up after repeated conflicts, rethrowing the conflict.", async () => {
            const deviceSyncState: any = { uid: "dss-1", version: 1 };
            const update = vi.fn().mockRejectedValue(conflict());
            const findOne = vi.fn().mockResolvedValue({ uid: "dss-1", version: 1 });

            await expect(persistDeviceSyncState(deviceSyncState, { update, findOne } as any, { a: 1 })).rejects.toThrow(/conflict/i);
            expect(update).toHaveBeenCalledTimes(5);
        });

        it("Rethrows a conflict when the row has disappeared, and any other error immediately.", async () => {
            const gone = { update: vi.fn().mockRejectedValue(conflict()), findOne: vi.fn().mockResolvedValue(undefined) };
            await expect(persistDeviceSyncState({ uid: "dss-1", version: 1 } as any, gone as any, { a: 1 })).rejects.toThrow(/conflict/i);

            const broken = { update: vi.fn().mockRejectedValue(new Error("db down")), findOne: vi.fn() };
            await expect(persistDeviceSyncState({ uid: "dss-1", version: 1 } as any, broken as any, { a: 1 })).rejects.toThrow("db down");
            expect(broken.findOne).not.toHaveBeenCalled();
        });
    });

    describe("cursors", () => {
        it("Orders positions by date, then uid.", () => {
            const d = new Date("2026-01-01T00:00:00.000Z");
            expect(compareCursor({ date: d, uid: "a" }, { date: d, uid: "b" })).toBeLessThan(0);
            expect(compareCursor({ date: d, uid: "b" }, { date: d, uid: "a" })).toBeGreaterThan(0);
            expect(compareCursor({ date: d, uid: "a" }, { date: d, uid: "a" })).toBe(0);
            expect(compareCursor({ date: new Date(0), uid: "z" }, { date: d, uid: "a" })).toBeLessThan(0);
            expect(epochCursor()).toEqual({ date: new Date(0), uid: "" });
        });

        it("Round-trips a SyncKey carrying a tie-breaking uid.", () => {
            const watermark = new Date("2026-09-04T12:00:00.000Z");
            const formatted = formatSyncKey({ generation: 4, watermark, uid: "row-7" });
            expect(formatted).toBe("4:2026-09-04T12:00:00.000Z#row-7");
            expect(parseSyncKey(formatted)).toEqual({ generation: 4, watermark, uid: "row-7" });
        });
    });

    describe("scanAfter", () => {
        it("Queries strictly after a (date, uid) cursor, live and deleted, and merges them in cursor order.", async () => {
            const queries: any[] = [];
            const repo: any = {
                find: vi.fn().mockImplementation(async (query: any) => {
                    queries.push(query);
                    return query.deleted === true
                        ? [{ uid: "b", dateModified: "2026-01-01T00:00:00.000Z", deleted: true }]
                        : [
                              { uid: "c", dateModified: "2026-01-01T00:00:00.000Z" },
                              { uid: "a", dateModified: "2026-01-02T00:00:00.000Z" },
                          ];
                }),
            };
            const cursor = { date: new Date("2026-01-01T00:00:00.000Z"), uid: "a" };

            const page = await scanAfter(repo, { folderUid: "f1" }, cursor, 2);

            expect(page.rows.map((r: any) => r.uid)).toEqual(["b", "c"]);
            expect(page.more).toBe(true);
            expect(queries[0]).toEqual({
                folderUid: "f1",
                $or: [
                    { dateModified: "gt(2026-01-01T00:00:00.000Z)" },
                    { dateModified: "range(2026-01-01T00:00:00.000Z,2026-01-01T00:00:00.000Z)", uid: "gt(a)" },
                ],
                sort: JSON.stringify({ dateModified: "ASC", uid: "ASC" }),
                limit: 3,
            });
            expect(queries[1].deleted).toBe(true);
        });

        it("Uses a plain date comparison when the cursor has no uid.", async () => {
            const repo: any = { find: vi.fn().mockResolvedValue([]) };

            const page = await scanAfter(repo, { mailboxUid: "m1" }, epochCursor(), 5);

            expect(page).toEqual({ rows: [], more: false });
            expect(repo.find.mock.calls[0][0].dateModified).toBe("gt(1970-01-01T00:00:00.000Z)");
            expect(repo.find.mock.calls[0][0].$or).toBeUndefined();
        });
    });

    describe("computeChanges", () => {
        function fakeRepo(rows: Record<string, any>[]): any {
            return {
                find: async (query: any) => rows.filter((row) => (query.deleted === true ? row.deleted === true : !row.deleted)),
            };
        }

        it("Classifies by creation time against the cursor: created after it is an Add, before it a Change; a deleted row the device can't have is skipped.", async () => {
            const cursor = { date: new Date("2026-01-01T00:00:00.000Z"), uid: "" };
            const rows = [
                { uid: "c", dateCreated: "2025-06-01T00:00:00.000Z", dateModified: "2026-01-03T00:00:00.000Z", deleted: false },
                // Created after the cursor and modified again before this round: still an Add, never an Update.
                { uid: "a", dateCreated: "2026-01-01T00:00:01.000Z", dateModified: "2026-01-01T05:00:00.000Z", deleted: false },
                { uid: "b", dateCreated: "2025-01-01T00:00:00.000Z", dateModified: "2026-01-02T00:00:00.000Z", deleted: true },
                { uid: "d", dateCreated: "2026-01-02T00:00:00.000Z", dateModified: "2026-01-02T01:00:00.000Z", deleted: true },
            ];
            const result = await computeChanges(fakeRepo(rows), "scopeUid", "s1", cursor, 10);

            expect(result.adds.map((r: any) => r.uid)).toEqual(["a"]);
            expect(result.changes.map((r: any) => r.uid)).toEqual(["c"]);
            expect(result.deletes.map((r: any) => r.uid)).toEqual(["b"]);
            expect(result.cursor).toEqual({ date: new Date("2026-01-03T00:00:00.000Z"), uid: "c" });
            expect(result.moreAvailable).toBe(false);
        });

        it("Sets moreAvailable when the combined live+deleted stream exceeds the window size, and keeps the cursor when nothing changed.", async () => {
            const cursor = { date: new Date("2026-01-01T00:00:00.000Z"), uid: "" };
            const rows = Array.from({ length: 3 }, (_, i) => ({
                uid: `row-${i}`,
                dateCreated: `2026-01-0${i + 2}T00:00:00.000Z`,
                dateModified: `2026-01-0${i + 2}T00:00:00.000Z`,
                deleted: false,
            }));
            const result = await computeChanges(fakeRepo(rows), "scopeUid", "s1", cursor, 2);
            expect(result.adds.length).toBe(2);
            expect(result.moreAvailable).toBe(true);

            const empty = await computeChanges(fakeRepo([]), "scopeUid", "s1", cursor, 2);
            expect(empty.cursor).toBe(cursor);
        });
    });
});
