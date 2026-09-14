///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import type { BaseEntity } from "@rapidrest/service-core";

/**
 * One fixed-size slice of the `ServerId`s a device holds for a `Sync` collection (see
 * `EasCollectionState.chunked`). A large collection's held set is split across these rows instead of one array on
 * the state row, so no single document approaches MongoDB's 16 MB limit and a round rewrites only the chunks its
 * own additions/removals touched rather than the whole set.
 *
 * @author Jean-Philippe Steinmetz
 */
export interface EasCollectionChunk extends BaseEntity {
    /** The caller's own `Mailbox` (the device's account), as on `EasCollectionState`. */
    mailboxUid: string;

    deviceId: string;

    /** The `Folder.uid` of the collection. */
    folderUid: string;

    /** Position of the chunk within the collection - unique per (mailbox, device, folder). */
    chunkIndex: number;

    /** The `ServerId`s this chunk holds (at most `HELD_CHUNK_SIZE`). */
    ids: string[];
}
