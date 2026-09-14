///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
// Unit tests for the held-set storage (EasCollectionStore.ts) against an in-memory chunk repo: inline vs chunked
// storage, delta writes that only touch changed chunks, paged loading and clearing. Real Mongo/SQL persistence of
// the chunk model is exercised by the Sync rounds in test/routes/{mongo,sql}/EasRoute.test.ts.
import { EasCollectionChunkMongo } from "../src/models/mongo/EasCollectionChunkMongo.js";
import { clearHeldSet, HELD_CHUNK_SIZE, INLINE_HELD_LIMIT, loadHeldSet, saveHeldSet } from "../src/EasCollectionStore.js";

const KEY = { mailboxUid: "mbx", deviceId: "dev", folderUid: "folder" };

/** An in-memory chunk repo implementing the query shapes the store issues. */
function chunkRepo(initial: any[] = []): any {
    let rows: any[] = initial.map((row) => ({ version: 1, ...KEY, ...row }));
    let next = rows.length;
    const repo = {
        rows: () => rows,
        find: vi.fn().mockImplementation(async (query: any) => {
            const after = Number(/^gt\((-?\d+)\)$/.exec(query.chunkIndex)![1]);
            return rows
                .filter((row) => row.folderUid === query.folderUid && row.chunkIndex > after)
                .sort((a, b) => a.chunkIndex - b.chunkIndex)
                .slice(0, query.limit);
        }),
        create: vi.fn().mockImplementation(async (obj: any) => {
            const row = { ...obj, uid: `chunk-${next++}`, version: 1 };
            rows.push(row);
            return row;
        }),
        update: vi.fn().mockImplementation(async (values: any) => {
            const row = rows.find((r) => r.uid === values.uid)!;
            Object.assign(row, values, { version: row.version + 1 });
            return row;
        }),
        delete: vi.fn().mockImplementation(async (uid: string) => {
            rows = rows.filter((row) => row.uid !== uid);
        }),
        truncate: vi.fn().mockImplementation(async (query: any) => {
            rows = rows.filter((row) => row.folderUid !== query.folderUid);
        }),
    };
    return repo;
}

const ids = (prefix: string, count: number) => Array.from({ length: count }, (_, i) => `${prefix}-${String(i).padStart(5, "0")}`);

describe("EasCollectionStore Tests", () => {
    it("Keeps a small, never-chunked held set inline without touching chunk rows.", async () => {
        const repo = chunkRepo();
        const store = { repo, chunkClass: EasCollectionChunkMongo };

        expect(await loadHeldSet(undefined, store)).toEqual({ ids: new Set(), chunks: [] });
        const loaded = await loadHeldSet({ serverIds: ["a"], chunked: false } as any, store);
        expect(loaded.ids).toEqual(new Set(["a"]));

        const saved = await saveHeldSet(KEY, loaded, new Set(["a", "b"]), false, store);
        expect(saved).toEqual({ serverIds: ["a", "b"], chunked: false });
        expect(repo.create).not.toHaveBeenCalled();
        expect(repo.find).not.toHaveBeenCalled();
    });

    it("Splits a held set past the inline limit into full chunks, and loads it back across pages of chunk rows.", async () => {
        const repo = chunkRepo();
        const store = { repo, chunkClass: EasCollectionChunkMongo };
        const all = new Set(ids("item", HELD_CHUNK_SIZE * 101 + 1));

        const saved = await saveHeldSet(KEY, { ids: new Set(), chunks: [] }, all, false, store);

        expect(saved).toEqual({ serverIds: [], chunked: true });
        expect(repo.rows()).toHaveLength(102);
        expect(repo.rows()[0]).toEqual(expect.objectContaining({ ...KEY, chunkIndex: 0 }));
        expect(repo.rows()[101].ids).toHaveLength(1);
        expect(INLINE_HELD_LIMIT).toBeLessThan(all.size);

        const loaded = await loadHeldSet({ ...KEY, chunked: true, serverIds: [] } as any, store);
        expect(loaded.ids).toEqual(all);
        expect(loaded.chunks).toHaveLength(102);
        // 102 rows at 100 per page: a second page after the first full one.
        expect(repo.find).toHaveBeenCalledTimes(2);
    });

    it("Writes only what a round changed: drops removed ids, fills free space before appending, deletes emptied chunks.", async () => {
        const repo = chunkRepo([
            { uid: "c0", chunkIndex: 0, ids: ["a", "b"] },
            { uid: "c1", chunkIndex: 1, ids: ["c"] },
            { uid: "c2", chunkIndex: 5, ids: ["d", "a"] },
            { uid: "c3", chunkIndex: 6, ids: ["untouched"] },
        ]);
        const store = { repo, chunkClass: EasCollectionChunkMongo };
        const loaded = await loadHeldSet({ ...KEY, chunked: true } as any, store);

        // "c" removed (c1 empties), "b" removed, "a" duplicated across chunks, one new id.
        const next = new Set(["a", "d", "untouched", "new"]);
        await saveHeldSet(KEY, loaded, next, true, store);

        expect(repo.delete).toHaveBeenCalledWith("c1", expect.objectContaining({ purge: true }));
        expect(repo.update).toHaveBeenCalledTimes(2);
        expect(repo.create).not.toHaveBeenCalled();
        const byUid = Object.fromEntries(repo.rows().map((row: any) => [row.uid, row.ids]));
        expect(byUid).toEqual({ c0: ["a", "new"], c2: ["d"], c3: ["untouched"] });

        // A chunked set stays chunked even once small; nothing changed means nothing written.
        repo.update.mockClear();
        const reloaded = await loadHeldSet({ ...KEY, chunked: true } as any, store);
        expect(await saveHeldSet(KEY, reloaded, new Set(reloaded.ids), true, store)).toEqual({ serverIds: [], chunked: true });
        expect(repo.update).not.toHaveBeenCalled();
    });

    it("Appends new chunks after the highest existing chunk index once existing chunks are full.", async () => {
        const repo = chunkRepo([{ uid: "c0", chunkIndex: 4, ids: ids("full", HELD_CHUNK_SIZE) }]);
        const store = { repo, chunkClass: EasCollectionChunkMongo };
        const loaded = await loadHeldSet({ ...KEY, chunked: true } as any, store);

        await saveHeldSet(KEY, loaded, new Set([...loaded.ids, "extra"]), true, store);

        expect(repo.update).not.toHaveBeenCalled();
        expect(repo.create).toHaveBeenCalledWith(expect.objectContaining({ chunkIndex: 5, ids: ["extra"] }), expect.anything());
    });

    it("Clears every chunk row of a collection.", async () => {
        const repo = chunkRepo([{ uid: "c0", chunkIndex: 0, ids: ["a"] }]);

        await clearHeldSet(KEY, { repo, chunkClass: EasCollectionChunkMongo });

        expect(repo.truncate).toHaveBeenCalledWith(KEY, { ignoreACL: true });
        expect(repo.rows()).toEqual([]);
    });
});
