///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import "reflect-metadata";
import { isMailboxScopedData } from "@rapidmx/restapi";
import { EasCollectionStateMongo } from "../../src/models/mongo/EasCollectionStateMongo.js";
import { EasCollectionStateSQL } from "../../src/models/sql/EasCollectionStateSQL.js";
import { EasCollectionChunkMongo } from "../../src/models/mongo/EasCollectionChunkMongo.js";
import { EasCollectionChunkSQL } from "../../src/models/sql/EasCollectionChunkSQL.js";

describe.each([
    ["EasCollectionStateMongo", EasCollectionStateMongo],
    ["EasCollectionStateSQL", EasCollectionStateSQL],
])("%s", (_name, Model: any) => {
    it("is purged with the rest of an erased mailbox's data", () => {
        expect(isMailboxScopedData(Model)).toBe(true);
    });

    it("falls back to class defaults when constructed with no data (or an empty object).", () => {
        for (const obj of [new Model(), new Model({})]) {
            expect(obj.mailboxUid).toBe("");
            expect(obj.deviceId).toBe("");
            expect(obj.folderUid).toBe("");
            expect(obj.collectionClass).toBe("");
            expect(obj.syncKey).toBe("");
            expect(obj.cursorDate).toEqual(new Date(0));
            expect(obj.cursorUid).toBe("");
            expect(obj.moveCursorDate).toEqual(new Date(0));
            expect(obj.moveCursorUid).toBe("");
            expect(obj.serverIds).toEqual([]);
            expect(obj.echoes).toEqual({});
            expect(obj.filterType).toBeUndefined();
            expect(obj.previous).toBeUndefined();
        }
    });

    it("applies provided overrides when constructed with data.", () => {
        const cursorDate = new Date("2026-01-20T00:00:00Z");
        const moveCursorDate = new Date("2026-01-19T00:00:00Z");
        const previous = {
            syncKey: "1:x",
            cursorDate: "a",
            cursorUid: "b",
            moveCursorDate: "c",
            moveCursorUid: "d",
            addedIds: ["e"],
            removedIds: ["f"],
            echoes: {},
            clientIds: [],
        };
        const obj = new Model({
            mailboxUid: "mailbox-1",
            deviceId: "device-1",
            folderUid: "folder-1",
            collectionClass: "Email",
            syncKey: "2:y",
            cursorDate,
            cursorUid: "row-1",
            moveCursorDate,
            moveCursorUid: "row-2",
            serverIds: ["m1"],
            echoes: { m1: "2026-01-20T00:00:00.000Z" },
            filterType: "3",
            chunked: true,
            recent: { m1: "2026-01-20T00:00:00.000Z" },
            reconcileCursor: "m0",
            previous,
        });

        expect(obj.mailboxUid).toBe("mailbox-1");
        expect(obj.deviceId).toBe("device-1");
        expect(obj.folderUid).toBe("folder-1");
        expect(obj.collectionClass).toBe("Email");
        expect(obj.syncKey).toBe("2:y");
        expect(obj.cursorDate).toBe(cursorDate);
        expect(obj.cursorUid).toBe("row-1");
        expect(obj.moveCursorDate).toBe(moveCursorDate);
        expect(obj.moveCursorUid).toBe("row-2");
        expect(obj.serverIds).toEqual(["m1"]);
        expect(obj.echoes).toEqual({ m1: "2026-01-20T00:00:00.000Z" });
        expect(obj.filterType).toBe("3");
        expect(obj.chunked).toBe(true);
        expect(obj.recent).toEqual({ m1: "2026-01-20T00:00:00.000Z" });
        expect(obj.reconcileCursor).toBe("m0");
        expect(obj.previous).toBe(previous);
    });
});

describe.each([
    ["EasCollectionChunkMongo", EasCollectionChunkMongo],
    ["EasCollectionChunkSQL", EasCollectionChunkSQL],
])("%s", (_name, Model: any) => {
    it("is purged with the rest of an erased mailbox's data", () => {
        expect(isMailboxScopedData(Model)).toBe(true);
    });

    it("falls back to class defaults, and applies provided values.", () => {
        for (const obj of [new Model(), new Model({})]) {
            expect([obj.mailboxUid, obj.deviceId, obj.folderUid, obj.chunkIndex, obj.ids]).toEqual(["", "", "", 0, []]);
        }
        const obj = new Model({ mailboxUid: "m", deviceId: "d", folderUid: "f", chunkIndex: 3, ids: ["a"] });
        expect([obj.mailboxUid, obj.deviceId, obj.folderUid, obj.chunkIndex, obj.ids]).toEqual(["m", "d", "f", 3, ["a"]]);
    });
});
