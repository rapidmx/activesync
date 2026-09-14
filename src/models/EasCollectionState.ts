///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import type { BaseEntity } from "@rapidrest/service-core";

/**
 * The sync state of one round of a `Sync` collection, as it stood *before* that round was applied - kept so a
 * client that never received a response (a dropped connection) can retry with the `SyncKey` it still holds, per
 * [MS-ASCMD]'s "the server MUST accept the previous SyncKey" rule, and so re-sent `Add`s are not created twice.
 * Only the round's delta against `serverIds` is kept (`addedIds`/`removedIds`), never a second full copy.
 */
export interface EasCollectionRound {
    /** The `SyncKey` the client sent for the round - accepting it again replays the round from this state. */
    syncKey: string;
    cursorDate: string;
    cursorUid: string;
    moveCursorDate: string;
    moveCursorUid: string;
    /** Item uids the round added to `serverIds` (removed again when the round is replayed). */
    addedIds: string[];
    /** Item uids the round removed from `serverIds` (restored when the round is replayed). */
    removedIds: string[];
    /** `echoes` as they stood before the round. */
    echoes: Record<string, string>;
    /** Each client `ClientId` with the `ServerId` created for it during the round, so a replayed `Add` is answered with
     * the same item instead of creating a duplicate. A list rather than a map: `ClientId` is client-chosen text, never
     * safe as a document/object key. */
    clientIds: { clientId: string; serverId: string }[];
}

/**
 * Per-device state of one EAS `Sync` collection (a folder), separate from `DeviceSyncState` so that concurrent
 * `Sync` requests for different folders of one device never contend for the same row, and so a large item set
 * never bloats the device row every other command reads.
 *
 * @author Jean-Philippe Steinmetz
 */
export interface EasCollectionState extends BaseEntity {
    /** The caller's own `Mailbox` (the device's account) - not necessarily the folder's owner for a shared folder. */
    mailboxUid: string;

    deviceId: string;

    /** The `Folder.uid` this collection syncs (the EAS `CollectionId`). */
    folderUid: string;

    /** The EAS `Class` (`"Email"`, `"Contacts"`, ...) of the collection, so later requests may omit `Class`. */
    collectionClass: string;

    /** The `SyncKey` most recently issued for this collection. */
    syncKey: string;

    /** Position in the folder's own `(dateModified, uid)` change stream. */
    cursorDate: Date;
    cursorUid: string;

    /** Position in the mailbox-wide stream of items outside this folder, which is how items moved out of the
     * folder (or deleted after being moved) are found and reported as `Delete`s. */
    moveCursorDate: Date;
    moveCursorUid: string;

    /** The `ServerId`s the device currently holds for this collection. Decides `Add` vs `Change` for a changed item
     * and whether a removed item needs a `Delete` at all. */
    serverIds: string[];

    /** Item uid -> the `dateModified` (ISO) the device's own write left on it. A changed row whose `dateModified`
     * still equals this value is the device's own `Add`/`Change` and is not echoed back. Entries are pruned once
     * `cursorDate` passes them. */
    echoes: Record<string, string>;

    /** The `FilterType` the collection was synced with (`undefined` = no filter). */
    filterType?: string;

    /** See `EasCollectionRound`. */
    previous?: EasCollectionRound;
}
