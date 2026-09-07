///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import type { RecoverableBaseEntity } from "@rapidrest/service-core";
import type { WbxmlElement } from "../codec/WbxmlElement.js";

/**
 * Maps one application entity type (`Message`/`Contact`/`CalendarEvent`/`Task`) to and from the EAS `Sync`
 * command's per-collection wire representation. `SyncCommand` itself only knows the generic Add/Change/Delete
 * cursor mechanics (shared with `FolderSyncCommand` via `EasSyncKeyUtils`) - everything entity-specific (which
 * fields go in `ApplicationData`, on which code pages) lives in one adapter per collection type, keyed by the
 * MS-ASCMD `Class` value (`"Email"`, `"Contacts"`, `"Calendar"`, `"Tasks"`) it answers to.
 *
 * Only reading (`toApplicationData`) is defined so far - `SyncCommand`'s pragmatic subset (see its own doc
 * comment) doesn't yet accept client-originated `Add`/`Change` commands for these collections (composing mail
 * goes through `SendMailCommand` instead; editing a synced item from the device is deferred, matching this
 * library's "pragmatic subset" precedent elsewhere).
 *
 * @author Jean-Philippe Steinmetz
 */
export interface EasCollectionSyncAdapter<T extends RecoverableBaseEntity> {
    /** The MS-ASCMD `Class` value this adapter handles, e.g. `"Email"`. */
    readonly collectionClass: string;

    /** Builds the `<ApplicationData>` element for one `Add`/`Change` command reporting `item`. */
    toApplicationData(item: T): WbxmlElement;
}
