///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import type { RecoverableBaseEntity } from "@rapidrest/service-core";
import type { Mailbox } from "@rapidmx/restapi";
import type { WbxmlElement } from "../codec/WbxmlElement.js";

/**
 * Maps one application entity type (`Message`/`Contact`/`CalendarEvent`/`Task`) to and from the EAS `Sync`
 * command's per-collection wire representation. `SyncCommand` itself only knows the generic Add/Change/Delete
 * cursor mechanics (shared with `FolderSyncCommand` via `EasSyncKeyUtils`) - everything entity-specific (which
 * fields go in `ApplicationData`, on which code pages) lives in one adapter per collection type, keyed by the
 * MS-ASCMD `Class` value (`"Email"`, `"Contacts"`, `"Calendar"`, `"Tasks"`) it answers to.
 *
 * `fromApplicationData` is deliberately optional: `SyncCommand` uses its absence as the capability check,
 * answering Status `6` for `Add`/`Change` on a collection whose adapter doesn't implement it, rather than
 * needing a separate flag that could drift out of sync with which adapters actually implement it. Every
 * adapter today (`Email`, `Contacts`, `Calendar`, `Tasks`) implements it.
 *
 * @author Jean-Philippe Steinmetz
 */
export interface EasCollectionSyncAdapter<T extends RecoverableBaseEntity> {
    /** The MS-ASCMD `Class` value this adapter handles, e.g. `"Email"`. */
    readonly collectionClass: string;

    /** Builds the `<ApplicationData>` element for one `Add`/`Change` command reporting `item`. */
    toApplicationData(item: T): WbxmlElement;

    /**
     * Parses one client-originated `Add`/`Change` command's `<ApplicationData>` element (`el`) into a partial
     * entity update. Only fields actually present in `el` are included in the result - an omitted field means
     * "unchanged" (MS-ASCMD's own "ghosted property" rule - see `SyncCommand`'s doc comment), never "clear this
     * field" - which is what lets the same method serve both `Add` (the partial is merged onto a fresh
     * `{mailboxUid, folderUid}` baseline) and `Change` (the partial is merged onto `existing`).
     *
     * May return a `Promise` - `EmailSyncAdapter` needs this for a Draft `Add`/`Change`'s body, which must be
     * written to `BlobStore` before the resulting `bodyBlobKey` is known; every other adapter today returns a
     * plain object, which `await`s through unchanged.
     *
     * @param el The command's `<ApplicationData>` element.
     * @param existing The item being changed, for a `Change` command; `undefined` for `Add`. Adapters that
     * need to know the item's current field values to correctly interpret a partial update - `EmailSyncAdapter`
     * uses this to reuse an existing Draft's `bodyBlobKey` on `Change` rather than minting a new one.
     */
    fromApplicationData?(el: WbxmlElement, existing?: T): Partial<T> | Promise<Partial<T>>;

    /**
     * Supplies default field values for a brand-new entity created via a client-originated `Add`, applied
     * *before* `fromApplicationData`'s own partial is merged on top (so anything the client actually sent
     * always wins). For defaults a fresh entity needs regardless of what the client sent - `CalendarSyncAdapter`
     * uses this for `icalUid`/`sequence`, since EAS's own `Add` command has no wire representation for either
     * (a device doesn't know or send an iCalendar UID) but a stored default of `""` for every Sync-created
     * event (this model's own fallback, see `CalendarEventMongo`'s constructor) would violate RFC 5545's own
     * uniqueness expectation for `UID`. `EmailSyncAdapter` uses `mailbox` to populate a new Draft's `from`.
     * Optional; only implemented where a collection actually needs it - most adapters have no such gap (and
     * ignore the `mailbox` parameter entirely).
     */
    newEntityDefaults?(mailbox: Mailbox): Partial<T>;
}
