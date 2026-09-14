///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
// Direct unit tests for the Sync collection enumeration (EasCollectionSync.ts) against an in-memory fake repo that
// implements just the query shapes `scanAfter` issues - enough to pin down every branch deterministically (budget
// exhaustion mid-stream, echo suppression, filter windows, the out-of-folder stream), which a real HTTP round trip
// can't reach reliably. End-to-end Sync behavior over real Mongo/SQL lives in test/routes/{mongo,sql}/EasRoute.test.ts.
import { FolderType } from "@rapidmx/restapi";
import {
    classForFolderType,
    cloneWorkingState,
    type CollectionWorkingState,
    enumerateCollection,
    filterPredicate,
    roundRecord,
    workingStateFromRound,
    workingStateFromRow,
} from "../src/EasCollectionSync.js";
import { formatSyncKey } from "../src/EasSyncKeyUtils.js";

interface Row {
    uid: string;
    folderUid: string;
    mailboxUid: string;
    dateModified: Date;
    deleted?: boolean;
    [key: string]: any;
}

/** Evaluates the `scanAfter` query shapes (`gt`/`range`/`ne` operands, `$or`, `deleted`, `limit`) over `rows`. */
function fakeRepo(rows: Row[]): any {
    const matches = (row: Row, query: Record<string, any>): boolean =>
        Object.entries(query).every(([key, value]) => {
            if (key === "sort" || key === "limit") return true;
            if (key === "$or") return (value as any[]).some((sub) => matches(row, sub));
            if (key === "deleted") return (row.deleted === true) === value;
            const op = /^(gt|range|ne)\((.*)\)$/.exec(String(value));
            const field = row[key] instanceof Date ? row[key].toISOString() : row[key];
            if (!op) return field === value;
            if (op[1] === "gt") return field > op[2];
            if (op[1] === "ne") return field !== op[2];
            const [lo, hi] = op[2].split(",");
            return field >= lo && field <= hi;
        });
    return {
        find: vi.fn().mockImplementation(async (query: any) => {
            const effective = "deleted" in query ? query : { ...query, deleted: false };
            return rows
                .filter((row) => matches(row, effective))
                .sort((a, b) => a.dateModified.getTime() - b.dateModified.getTime() || (a.uid < b.uid ? -1 : 1))
                .slice(0, query.limit);
        }),
    };
}

const t = (minutes: number) => new Date(Date.UTC(2026, 0, 1, 0, minutes));

function state(overrides: Partial<CollectionWorkingState> = {}): CollectionWorkingState {
    return {
        generation: 1,
        cursor: { date: new Date(0), uid: "" },
        moveCursor: { date: new Date(0), uid: "" },
        serverIds: new Set(),
        echoes: new Map(),
        filterType: "0",
        ...overrides,
    };
}

const base = { folderUid: "inbox", folderMailboxUid: "mbx", moveScanLimit: 100, now: t(1000) };

describe("EasCollectionSync Tests", () => {
    describe("enumerateCollection", () => {
        it("Reports items the device lacks as Adds and items it holds as Changes, advancing the cursor to the last row.", async () => {
            const repo = fakeRepo([
                { uid: "a", folderUid: "inbox", mailboxUid: "mbx", dateModified: t(1) },
                { uid: "b", folderUid: "inbox", mailboxUid: "mbx", dateModified: t(2) },
            ]);
            const s = state({ serverIds: new Set(["b"]) });

            const { commands, moreAvailable } = await enumerateCollection(s, { ...base, repo, windowSize: 10 });

            expect(commands.map((c: any) => `${c.kind}:${c.item?.uid ?? c.uid}`)).toEqual(["Add:a", "Change:b"]);
            expect(moreAvailable).toBe(false);
            expect(s.cursor).toEqual({ date: t(2), uid: "b" });
            expect([...s.serverIds].sort()).toEqual(["a", "b"]);
        });

        it("Reports a deleted item only when the device holds it.", async () => {
            const repo = fakeRepo([
                { uid: "held", folderUid: "inbox", mailboxUid: "mbx", dateModified: t(1), deleted: true },
                { uid: "never-sent", folderUid: "inbox", mailboxUid: "mbx", dateModified: t(2), deleted: true },
            ]);
            const s = state({ serverIds: new Set(["held"]), moveCursor: { date: t(500), uid: "" } });

            const { commands } = await enumerateCollection(s, { ...base, repo, windowSize: 10 });

            expect(commands).toEqual([{ kind: "Delete", uid: "held" }]);
            expect(s.serverIds.size).toBe(0);
            expect(s.cursor.uid).toBe("never-sent");
        });

        it("Reports an item moved to another folder of the mailbox as a Delete, and doesn't also Add/Change a stale folder-stream copy of it.", async () => {
            const rows: Row[] = [{ uid: "moved", folderUid: "archive", mailboxUid: "mbx", dateModified: t(5) }];
            const repo = fakeRepo(rows);
            // The folder stream is read first, so an item that moves between the two reads is seen in both.
            repo.find.mockImplementationOnce(async () => [{ uid: "moved", folderUid: "inbox", mailboxUid: "mbx", dateModified: t(4) }]);
            const s = state({ serverIds: new Set(["moved", "other"]) });

            const { commands } = await enumerateCollection(s, { ...base, repo, windowSize: 10 });

            expect(commands).toEqual([{ kind: "Delete", uid: "moved" }]);
            expect([...s.serverIds]).toEqual(["other"]);
            expect(s.moveCursor).toEqual({ date: t(5), uid: "moved" });
        });

        it("Skips the device's own write (dateModified still equal to the recorded echo) and prunes echoes the cursor has passed.", async () => {
            const repo = fakeRepo([
                { uid: "mine", folderUid: "inbox", mailboxUid: "mbx", dateModified: t(3) },
                { uid: "edited-again", folderUid: "inbox", mailboxUid: "mbx", dateModified: t(4) },
            ]);
            const s = state({
                serverIds: new Set(["mine", "edited-again"]),
                moveCursor: { date: t(900), uid: "" },
                echoes: new Map([
                    ["mine", t(3).toISOString()],
                    ["edited-again", t(2).toISOString()],
                    ["future", t(50).toISOString()],
                ]),
            });

            const { commands } = await enumerateCollection(s, { ...base, repo, windowSize: 10 });

            expect(commands.map((c: any) => c.item.uid)).toEqual(["edited-again"]);
            expect([...s.echoes.keys()]).toEqual(["future"]);
        });

        it("Stops at the window size, reporting moreAvailable and leaving the cursor before the first unreported row.", async () => {
            const repo = fakeRepo([
                { uid: "a", folderUid: "inbox", mailboxUid: "mbx", dateModified: t(1) },
                { uid: "b", folderUid: "inbox", mailboxUid: "mbx", dateModified: t(1) },
                { uid: "c", folderUid: "inbox", mailboxUid: "mbx", dateModified: t(1) },
            ]);
            const s = state();

            const first = await enumerateCollection(s, { ...base, repo, windowSize: 2 });
            expect(first.commands.map((c: any) => c.item.uid)).toEqual(["a", "b"]);
            expect(first.moreAvailable).toBe(true);
            expect(s.cursor).toEqual({ date: t(1), uid: "b" });

            // Rows sharing one timestamp across the page boundary are neither skipped nor repeated.
            const second = await enumerateCollection(s, { ...base, repo, windowSize: 2 });
            expect(second.commands.map((c: any) => c.item.uid)).toEqual(["c"]);
            expect(second.moreAvailable).toBe(false);
        });

        it("Stops the out-of-folder stream when the window fills, then reports nothing more from the folder stream.", async () => {
            const repo = fakeRepo([
                { uid: "x", folderUid: "archive", mailboxUid: "mbx", dateModified: t(1) },
                { uid: "y", folderUid: "archive", mailboxUid: "mbx", dateModified: t(2) },
                { uid: "z", folderUid: "inbox", mailboxUid: "mbx", dateModified: t(3) },
            ]);
            const s = state({ serverIds: new Set(["x", "y"]) });

            const { commands, moreAvailable } = await enumerateCollection(s, { ...base, repo, windowSize: 1 });

            expect(commands).toEqual([{ kind: "Delete", uid: "x" }]);
            expect(moreAvailable).toBe(true);
            expect(s.moveCursor).toEqual({ date: t(1), uid: "x" });
            expect(s.cursor).toEqual({ date: new Date(0), uid: "" });
        });

        it("Reports moreAvailable when the out-of-folder page itself overflows, even with nothing to report from it.", async () => {
            const repo = fakeRepo([
                { uid: "p", folderUid: "archive", mailboxUid: "mbx", dateModified: t(1) },
                { uid: "q", folderUid: "archive", mailboxUid: "mbx", dateModified: t(2) },
            ]);
            const s = state({ serverIds: new Set(["held"]) });

            const { commands, moreAvailable } = await enumerateCollection(s, { ...base, repo, windowSize: 10, moveScanLimit: 1 });

            expect(commands).toEqual([]);
            expect(moreAvailable).toBe(true);
            expect(s.moveCursor.uid).toBe("p");
        });

        it("Doesn't add an item outside the filter window, but still changes one the device already holds.", async () => {
            const repo = fakeRepo([
                { uid: "old", folderUid: "inbox", mailboxUid: "mbx", dateModified: t(1), keep: false },
                { uid: "held-old", folderUid: "inbox", mailboxUid: "mbx", dateModified: t(2), keep: false },
            ]);
            const s = state({ serverIds: new Set(["held-old"]), moveCursor: { date: t(900), uid: "" } });

            const { commands } = await enumerateCollection(s, { ...base, repo, windowSize: 10, include: (item: any) => item.keep });

            expect(commands.map((c: any) => `${c.kind}:${c.item.uid}`)).toEqual(["Change:held-old"]);
            expect(s.cursor.uid).toBe("held-old");
        });

        it("Fast-forwards the out-of-folder cursor while the device holds nothing, but never moves it backwards.", async () => {
            const repo = fakeRepo([]);
            const behind = state();
            await enumerateCollection(behind, { ...base, repo, windowSize: 10 });
            expect(behind.moveCursor).toEqual({ date: new Date(t(1000).getTime() - 60_000), uid: "" });

            const ahead = state({ moveCursor: { date: t(2000), uid: "k" } });
            await enumerateCollection(ahead, { ...base, repo, windowSize: 10 });
            expect(ahead.moveCursor).toEqual({ date: t(2000), uid: "k" });

            // Defaults `now` to the current time when not given.
            const live = state();
            await enumerateCollection(live, { ...base, now: undefined, repo, windowSize: 10 });
            expect(live.moveCursor.date.getTime()).toBeGreaterThan(t(0).getTime());
        });
    });

    describe("working state", () => {
        const row: any = {
            syncKey: formatSyncKey({ generation: 3, watermark: t(9) }),
            cursorDate: t(9),
            cursorUid: "c9",
            moveCursorDate: t(8),
            moveCursorUid: "m8",
            serverIds: ["a", "new"],
            echoes: { a: t(9).toISOString() },
            filterType: "3",
            previous: {
                syncKey: formatSyncKey({ generation: 2, watermark: t(5) }),
                cursorDate: t(5).toISOString(),
                cursorUid: "c5",
                moveCursorDate: t(4).toISOString(),
                moveCursorUid: "m4",
                addedIds: ["new"],
                removedIds: ["gone"],
                echoes: {},
                clientIds: [{ clientId: "client-1", serverId: "new" }],
            },
        };

        it("Loads the current round from the row.", () => {
            const s = workingStateFromRow(row);
            expect(s.generation).toBe(3);
            expect(s.cursor).toEqual({ date: t(9), uid: "c9" });
            expect(s.moveCursor).toEqual({ date: t(8), uid: "m8" });
            expect([...s.serverIds]).toEqual(["a", "new"]);
            expect(s.echoes.get("a")).toBe(t(9).toISOString());
            expect(s.filterType).toBe("3");
        });

        it("Rebuilds the state before the previous round, undoing its delta.", () => {
            const s = workingStateFromRound(row, row.previous);
            expect(s.generation).toBe(2);
            expect(s.cursor).toEqual({ date: t(5), uid: "c5" });
            expect(s.moveCursor).toEqual({ date: t(4), uid: "m4" });
            expect([...s.serverIds].sort()).toEqual(["a", "gone"]);
            expect(s.echoes.size).toBe(0);
        });

        it("Tolerates a corrupt key, missing echoes and an unset filter.", () => {
            const s = workingStateFromRow({ ...row, syncKey: "garbage", echoes: undefined, filterType: undefined });
            expect(s.generation).toBe(0);
            expect(s.echoes.size).toBe(0);
            expect(s.filterType).toBe("0");
            const r = workingStateFromRound({ ...row, filterType: undefined }, { ...row.previous, syncKey: "garbage" });
            expect(r.generation).toBe(0);
            expect(r.filterType).toBe("0");
        });

        it("Clones deeply and records a round's delta.", () => {
            const before = workingStateFromRow(row);
            const after = cloneWorkingState(before);
            after.serverIds.delete("a");
            after.serverIds.add("z");
            after.cursor.uid = "moved";
            expect(before.serverIds.has("a")).toBe(true);
            expect(before.cursor.uid).toBe("c9");

            const record = roundRecord("key-1", before, after, new Map([["c", "z"]]));
            expect(record).toEqual({
                syncKey: "key-1",
                cursorDate: t(9).toISOString(),
                cursorUid: "c9",
                moveCursorDate: t(8).toISOString(),
                moveCursorUid: "m8",
                addedIds: ["z"],
                removedIds: ["a"],
                echoes: { a: t(9).toISOString() },
                clientIds: [{ clientId: "c", serverId: "z" }],
            });
        });
    });

    describe("filterPredicate", () => {
        const now = new Date("2026-06-15T00:00:00.000Z");
        const daysAgo = (days: number) => new Date(now.getTime() - days * 24 * 60 * 60 * 1000);

        it("Windows Email by receivedDate for FilterType 1-5.", () => {
            const include = filterPredicate("Email", "3", now)!;
            expect(include({ receivedDate: daysAgo(6) })).toBe(true);
            expect(include({ receivedDate: daysAgo(8) })).toBe(false);
            expect(filterPredicate("Email", "6", now)).toBeUndefined();
        });

        it("Windows Calendar by endDate for FilterType 4-7, always keeping recurring events.", () => {
            const include = filterPredicate("Calendar", "4", now)!;
            expect(include({ endDate: daysAgo(10) })).toBe(true);
            expect(include({ endDate: daysAgo(20) })).toBe(false);
            expect(include({ endDate: daysAgo(400), recurrenceRule: { freq: "weekly" } })).toBe(true);
            expect(filterPredicate("Calendar", "2", now)).toBeUndefined();
        });

        it("Keeps only incomplete Tasks for FilterType 8, and applies no filter otherwise.", () => {
            const include = filterPredicate("Tasks", "8", now)!;
            expect(include({ completed: false })).toBe(true);
            expect(include({ completed: true })).toBe(false);
            expect(filterPredicate("Tasks", "0", now)).toBeUndefined();
            expect(filterPredicate("Contacts", "3", now)).toBeUndefined();
            expect(filterPredicate("Email", "0")).toBeUndefined();
        });
    });

    it("classForFolderType maps a folder's type to the Class it holds.", () => {
        expect(classForFolderType(FolderType.CALENDAR)).toBe("Calendar");
        expect(classForFolderType(FolderType.CONTACTS)).toBe("Contacts");
        expect(classForFolderType(FolderType.TASKS)).toBe("Tasks");
        expect(classForFolderType(FolderType.INBOX)).toBe("Email");
        expect(classForFolderType(FolderType.USER)).toBe("Email");
    });
});
