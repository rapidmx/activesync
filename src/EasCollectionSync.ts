///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import type { RecoverableBaseEntity, RepoUtils } from "@rapidrest/service-core";
import { FolderType } from "@rapidmx/restapi";
import { type ChangeCursor, compareCursor, cursorOf, parseSyncKey, scanAfter } from "./EasSyncKeyUtils.js";
import type { EasCollectionRound, EasCollectionState } from "./models/EasCollectionState.js";

/** How far before a round's start the out-of-folder cursor is fast-forwarded while the device holds nothing -
 * generous slack for clock differences between the servers stamping `dateModified`. */
const MOVE_CURSOR_SLACK_MS = 60_000;

/** The in-memory, mutable form of an `EasCollectionState` for one `Sync`/`GetItemEstimate` round. */
export interface CollectionWorkingState {
    generation: number;
    cursor: ChangeCursor;
    moveCursor: ChangeCursor;
    serverIds: Set<string>;
    echoes: Map<string, string>;
    filterType: string;
}

/** One server-side change to report to the device. */
export type CollectionCommand<T> = { kind: "Add" | "Change"; item: T } | { kind: "Delete"; uid: string };

/** Loads the working state for the round a client's current `SyncKey` (`state.syncKey`) continues. */
export function workingStateFromRow(state: EasCollectionState): CollectionWorkingState {
    return {
        generation: parseSyncKey(state.syncKey)?.generation ?? 0,
        cursor: { date: new Date(state.cursorDate), uid: state.cursorUid },
        moveCursor: { date: new Date(state.moveCursorDate), uid: state.moveCursorUid },
        serverIds: new Set(state.serverIds),
        echoes: new Map(Object.entries(state.echoes ?? {})),
        filterType: state.filterType ?? "0",
    };
}

/** Rebuilds the working state as it stood before the most recent round, for a client retrying `round.syncKey`. */
export function workingStateFromRound(state: EasCollectionState, round: EasCollectionRound): CollectionWorkingState {
    const serverIds = new Set(state.serverIds);
    for (const uid of round.addedIds) {
        serverIds.delete(uid);
    }
    for (const uid of round.removedIds) {
        serverIds.add(uid);
    }
    return {
        generation: parseSyncKey(round.syncKey)?.generation ?? 0,
        cursor: { date: new Date(round.cursorDate), uid: round.cursorUid },
        moveCursor: { date: new Date(round.moveCursorDate), uid: round.moveCursorUid },
        serverIds,
        echoes: new Map(Object.entries(round.echoes)),
        filterType: state.filterType ?? "0",
    };
}

/** Deep-copies a working state so a dry run (`GetItemEstimate`) can't disturb the original. */
export function cloneWorkingState(state: CollectionWorkingState): CollectionWorkingState {
    return {
        ...state,
        cursor: { ...state.cursor },
        moveCursor: { ...state.moveCursor },
        serverIds: new Set(state.serverIds),
        echoes: new Map(state.echoes),
    };
}

/** Records the round that turned `base` into `result` (see `EasCollectionRound`). */
export function roundRecord(
    syncKey: string,
    base: CollectionWorkingState,
    result: CollectionWorkingState,
    clientIds: Map<string, string>,
): EasCollectionRound {
    return {
        syncKey,
        cursorDate: base.cursor.date.toISOString(),
        cursorUid: base.cursor.uid,
        moveCursorDate: base.moveCursor.date.toISOString(),
        moveCursorUid: base.moveCursor.uid,
        addedIds: [...result.serverIds].filter((uid) => !base.serverIds.has(uid)),
        removedIds: [...base.serverIds].filter((uid) => !result.serverIds.has(uid)),
        echoes: Object.fromEntries(base.echoes),
        clientIds: [...clientIds].map(([clientId, serverId]) => ({ clientId, serverId })),
    };
}

export interface EnumerateCollectionOptions<T> {
    repo: RepoUtils<T & RecoverableBaseEntity>;
    folderUid: string;
    /** The mailbox that owns the folder - items moved out of it stay within this mailbox. */
    folderMailboxUid: string;
    /** Most commands to report. */
    windowSize: number;
    /** Rows read from the out-of-folder stream per round. */
    moveScanLimit: number;
    /** `FilterType` window: an item the device doesn't hold yet is only added when this returns `true`. */
    include?: (item: T) => boolean;
    now?: Date;
}

/**
 * Computes one round of server-side changes for a `Sync` collection and advances `state` past them:
 *
 * - **Folder stream** (rows of this folder after `state.cursor`): a live item the device holds is a `Change`, one
 * it doesn't hold is an `Add` (subject to `include`), a soft-deleted item it holds is a `Delete`; a row whose
 * `dateModified` still equals the device's own recorded write (`state.echoes`) is skipped.
 * - **Out-of-folder stream** (rows of the same mailbox in any other folder after `state.moveCursor`, live or
 * deleted): an item the device holds has been moved out of this folder and is a `Delete`. Read after the folder
 * stream, so when an item moves between the two reads the out-of-folder row (the newer one) wins. Skipped while
 * the device holds nothing; the cursor is then fast-forwarded to just before the round started instead, so the
 * first real scan doesn't have to crawl the whole mailbox history.
 *
 * Both cursors only ever advance past rows actually processed - never to "now" - so nothing is skipped when the
 * window fills up (`moreAvailable`).
 */
export async function enumerateCollection<T extends RecoverableBaseEntity>(
    state: CollectionWorkingState,
    options: EnumerateCollectionOptions<T>,
): Promise<{ commands: CollectionCommand<T>[]; moreAvailable: boolean }> {
    const startedAt: number = (options.now ?? new Date()).getTime();
    const folderPage = await scanAfter<T>(options.repo, { folderUid: options.folderUid }, state.cursor, options.windowSize);
    const movePage =
        state.serverIds.size > 0
            ? await scanAfter<T>(
                  options.repo,
                  { mailboxUid: options.folderMailboxUid, folderUid: `ne(${options.folderUid})` },
                  state.moveCursor,
                  options.moveScanLimit,
              )
            : undefined;

    const commands: CollectionCommand<T>[] = [];
    let budget: number = options.windowSize;
    let moreAvailable: boolean = folderPage.more || !!movePage?.more;

    const movedOut = new Set<string>();
    if (movePage) {
        for (const row of movePage.rows) {
            if (state.serverIds.has(row.uid)) {
                if (budget === 0) {
                    moreAvailable = true;
                    break;
                }
                commands.push({ kind: "Delete", uid: row.uid });
                state.serverIds.delete(row.uid);
                budget--;
            }
            movedOut.add(row.uid);
            state.moveCursor = cursorOf(row);
        }
    } else {
        const floor: ChangeCursor = { date: new Date(startedAt - MOVE_CURSOR_SLACK_MS), uid: "" };
        if (compareCursor(floor, state.moveCursor) > 0) {
            state.moveCursor = floor;
        }
    }

    for (const row of folderPage.rows) {
        const uid: string = row.uid;
        const echo: string | undefined = state.echoes.get(uid);
        let command: CollectionCommand<T> | undefined;
        if (movedOut.has(uid) || (echo !== undefined && echo === new Date((row as any).dateModified).toISOString())) {
            command = undefined;
        } else if ((row as any).deleted === true) {
            command = state.serverIds.has(uid) ? { kind: "Delete", uid } : undefined;
        } else if (state.serverIds.has(uid)) {
            command = { kind: "Change", item: row };
        } else if (!options.include || options.include(row)) {
            command = { kind: "Add", item: row };
        }
        if (command) {
            if (budget === 0) {
                moreAvailable = true;
                break;
            }
            commands.push(command);
            if (command.kind === "Delete") {
                state.serverIds.delete(uid);
            } else {
                state.serverIds.add(uid);
            }
            budget--;
        }
        state.cursor = cursorOf(row);
    }

    for (const [uid, iso] of state.echoes) {
        if (compareCursor({ date: new Date(iso), uid }, state.cursor) <= 0) {
            state.echoes.delete(uid);
        }
    }

    return { commands, moreAvailable };
}

/** The `Class` a folder of `type` holds - for a `Sync`/`GetItemEstimate` request that omits `Class` for a collection
 * with no remembered class. */
export function classForFolderType(type: FolderType): string {
    switch (type) {
        case FolderType.CALENDAR:
            return "Calendar";
        case FolderType.CONTACTS:
            return "Contacts";
        case FolderType.TASKS:
            return "Tasks";
        default:
            return "Email";
    }
}

const DAY_MS = 24 * 60 * 60 * 1000;

/** [MS-ASCMD] `FilterType` age windows, in days (`1`..`7`). */
const FILTER_DAYS: Record<string, number> = { "1": 1, "2": 3, "3": 7, "4": 14, "5": 30, "6": 90, "7": 180 };

/**
 * Builds the `include` predicate for a collection's `FilterType`, or `undefined` for no filtering: `Email` keeps
 * messages received within the window; `Calendar` keeps recurring events and events ending within it; `Tasks`
 * keeps incomplete tasks for `8`. Values a class doesn't define are treated as "no filter".
 */
export function filterPredicate(collectionClass: string, filterType: string, now: Date = new Date()): ((item: any) => boolean) | undefined {
    const days: number | undefined = FILTER_DAYS[filterType];
    if (collectionClass === "Email" && days !== undefined && days <= 30) {
        const cutoff = now.getTime() - days * DAY_MS;
        return (item) => new Date(item.receivedDate).getTime() >= cutoff;
    }
    if (collectionClass === "Calendar" && days !== undefined && days >= 14) {
        const cutoff = now.getTime() - days * DAY_MS;
        return (item) => !!item.recurrenceRule || new Date(item.endDate).getTime() >= cutoff;
    }
    if (collectionClass === "Tasks" && filterType === "8") {
        return (item) => !item.completed;
    }
    return undefined;
}
