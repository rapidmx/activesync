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
import { computeChanges, formatSyncKey, parseSyncKey, resolveSyncKey } from "../src/EasSyncKeyUtils.js";

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

    describe("computeChanges", () => {
        function fakeRepo(rows: Record<string, any>[]): any {
            return {
                find: async (query: any) => rows.filter((row) => (query.deleted === true ? row.deleted === true : !row.deleted)),
            };
        }

        it("Merges live and deleted rows into a single dateModified-ordered stream spanning more than one comparison.", async () => {
            const watermark = new Date("2026-01-01T00:00:00.000Z");
            const rows = [
                // Deliberately out of dateModified order and interleaved live/deleted, so the merge's sort
                // comparator is exercised across several real (not single-element) comparisons.
                { uid: "c", scopeUid: "s1", dateCreated: "2026-01-01T00:00:03.000Z", dateModified: "2026-01-03T00:00:00.000Z", deleted: false },
                { uid: "a", scopeUid: "s1", dateCreated: "2026-01-01T00:00:01.000Z", dateModified: "2026-01-01T00:00:01.000Z", deleted: false },
                { uid: "b", scopeUid: "s1", dateCreated: "2025-01-01T00:00:00.000Z", dateModified: "2026-01-02T00:00:00.000Z", deleted: true },
            ];
            const result = await computeChanges(fakeRepo(rows), "scopeUid", "s1", watermark, 10);

            expect(result.adds.map((r: any) => r.uid)).toEqual(["a"]);
            expect(result.changes.map((r: any) => r.uid)).toEqual(["c"]);
            expect(result.deletes.map((r: any) => r.uid)).toEqual(["b"]);
            expect(result.newWatermark).toEqual(new Date("2026-01-03T00:00:00.000Z"));
            expect(result.moreAvailable).toBe(false);
        });

        it("Sets moreAvailable when the combined live+deleted stream exceeds the window size.", async () => {
            const watermark = new Date("2026-01-01T00:00:00.000Z");
            const rows = Array.from({ length: 3 }, (_, i) => ({
                uid: `row-${i}`,
                scopeUid: "s1",
                dateCreated: `2026-01-0${i + 1}T00:00:00.000Z`,
                dateModified: `2026-01-0${i + 1}T00:00:00.000Z`,
                deleted: false,
            }));
            const result = await computeChanges(fakeRepo(rows), "scopeUid", "s1", watermark, 2);

            expect(result.adds.length).toBe(2);
            expect(result.moreAvailable).toBe(true);
        });
    });
});
