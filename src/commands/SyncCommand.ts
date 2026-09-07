///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import { ApiError, ObjectDecorators } from "@rapidrest/core";
import { ApiErrors, ObjectFactory, RepoUtils, type RecoverableBaseEntity } from "@rapidrest/service-core";
import { RecoverableRepoUtils, type Mailbox } from "@rapidmx/restapi";
import { WbxmlCodePage } from "../codec/WbxmlCodePages.js";
import { childText, element, findChild, findChildren, textElement, type WbxmlElement } from "../codec/WbxmlElement.js";
import { computeChanges, formatSyncKey, persistDeviceSyncState, resolveSyncKey } from "../EasSyncKeyUtils.js";
import type { EasCommandContext, EasCommandHandler } from "../EasCommandHandler.js";
import type { EasCollectionSyncAdapter } from "../adapters/EasCollectionSyncAdapter.js";
const { Config, Init } = ObjectDecorators;

/** Caps how many item changes are enumerated per `Sync` round - a real device-visible "MoreAvailable" trigger
 * for a busy folder, not a real-world binding constraint (unlike `FolderSyncCommand`'s much smaller folder
 * hierarchy, an Inbox can easily exceed this in one round). */
const DEFAULT_WINDOW_SIZE = 100;

/** Binds one MS-ASCMD `Class` value (`"Email"`, `"Contacts"`, ...) to the concrete entity class `SyncCommand`
 * should build a `RepoUtils` for, and the adapter class that maps that entity to/from `ApplicationData`.
 * Supplied by the Mongo/SQL concrete subclasses, one map entry per supported collection type.
 *
 * `adapterClass`, not a pre-built `adapter` instance: `SyncCommand.init()` instantiates each one itself via
 * `ObjectFactory`, so an adapter can `@Inject` its own dependencies (`EmailSyncAdapter` needs `BlobStore` for a
 * Draft's body) exactly like any other DI-managed class in this library - a bare `new EmailSyncAdapter()` has
 * no way to satisfy that. */
export interface SyncCollectionBinding<T extends RecoverableBaseEntity> {
    entityClass: any;
    adapterClass: any;
}

/**
 * Handles EAS `Sync`: enumerates `Add`/`Change`/`Delete`s for a single folder's contents since the device's last
 * `Sync` of that folder, using the same watermark-based cursor mechanism `FolderSyncCommand` uses (via
 * `EasSyncKeyUtils`), scoped by `folderUid` instead of `mailboxUid`, and keyed per-folder in
 * `DeviceSyncState.folderSyncKeys` (the `CollectionId` a client sends *is* the `folderUid` - this library never
 * invents a separate collection identifier).
 *
 * **Multi-collection requests**: every `<Collection>` in a request's `<Collections>` is processed and gets its
 * own `<Collection>` entry in the response, each with its own independent `SyncKey`/`Status` - a client
 * syncing several folders in one round trip (the common case once the initial per-folder backlog is done)
 * gets one response covering all of them. All per-collection `SyncKey`/remembered-`Class` writes for the whole
 * request are batched into a single `persistDeviceSyncState` call after every collection has been processed
 * (never one call per collection) - see `EasSyncKeyUtils.persistDeviceSyncState`'s own doc comment for why a
 * second write to the same `DeviceSyncState` within one request must never be built off a stale copy.
 *
 * **`Class` is only required on a collection's first (`SyncKey "0"`) request**, per `[MS-ASCMD]` - once seen,
 * it's remembered in `DeviceSyncState.folderCollectionClasses` (keyed by `folderUid`) so a later request may
 * omit it; omitting it for a folder never previously synced still gets `Status 4` (nothing to fall back to).
 *
 * **Pragmatic subset, deliberately not the full MS-ASCMD `Sync` surface**:
 * - **Client-originated `Add`/`Change`/`Delete` commands are accepted for `Contacts`/`Calendar`/`Tasks`** (a
 * device creating/editing/deleting an item directly - see `applyAdd`/`applyChange`/`applyDelete`). `Email`
 * only accepts `Delete` (a real, common operation - a client deleting a message locally); `Add` is rejected
 * with Status `6` for every collection whose bound `EasCollectionSyncAdapter` has no `fromApplicationData`
 * (only `EmailSyncAdapter`, today) - `[MS-ASCMD]` itself disallows non-draft email `Add` outright, and this
 * pragmatic subset doesn't implement Drafts-via-`Add` or Read/Flagged-via-`Change` for `Email` either
 * (composing/sending mail goes through `SendMailCommand` instead) - both documented gaps, not silently
 * dropped. Per `[MS-ASCMD]`'s own "Add (Sync)"/"Status (Sync)" pages: `Add` always gets a `Responses` entry
 * (it must report the assigned `ServerId`); `Change`/`Delete` only get one on **failure** - a silent success
 * means "assume it worked."
 * - Only a body preview is returned per item (see `EmailSyncAdapter`'s own doc comment) - full body content is
 * fetched separately via `ItemOperationsCommand`.
 *
 * @author Jean-Philippe Steinmetz
 */
export abstract class SyncCommand implements EasCommandHandler {
    public readonly command = "Sync";

    protected abstract collectionBindings: Record<string, SyncCollectionBinding<any>>;

    /** Supplied by the Mongo/SQL concrete subclasses so a client-originated `Add`'s `newEntityDefaults()` can
     * be given the caller's own `Mailbox` (`EmailSyncAdapter` needs it for a new Draft's `from`) - same
     * one-line-per-backend pattern `MeetingResponseCommand`/`SettingsCommand` already use. */
    protected abstract mailboxClass: any;

    @Config("mail:eas:sync_window_size", DEFAULT_WINDOW_SIZE)
    private windowSize: number = DEFAULT_WINDOW_SIZE;

    // Automatically injected by ObjectFactory on instantiation
    private _objectFactory?: ObjectFactory;

    private repos = new Map<string, RepoUtils<any>>();
    private adapters = new Map<string, EasCollectionSyncAdapter<any>>();
    private mailboxRepo?: RepoUtils<any>;

    @Init
    public async init(): Promise<void> {
        this.mailboxRepo = await this._objectFactory!.newInstance(RepoUtils, {
            name: this.mailboxClass.name,
            args: [this.mailboxClass],
        });
        for (const [collectionClass, binding] of Object.entries(this.collectionBindings)) {
            // RecoverableRepoUtils, not plain RepoUtils: SyncCommand now originates its own deletes
            // (`applyDelete`) - without it, a soft-delete here wouldn't bump `dateModified`/`version`,
            // breaking this exact class's own watermark-based deletion detection for anything deleted via
            // Sync instead of the REST API. The same fix `BaseMapiEmsmdbRoute.ts` already needed for MAPI.
            this.repos.set(
                collectionClass,
                await this._objectFactory!.newInstance(RecoverableRepoUtils, {
                    name: binding.entityClass.name,
                    args: [binding.entityClass],
                }),
            );
            this.adapters.set(collectionClass, await this._objectFactory!.newInstance(binding.adapterClass));
        }
    }

    /** Resolves the caller's own `Mailbox` at most once per request, and only if actually needed - most `Sync`
     * requests contain no client-originated `Add` at all, so most requests never pay this extra round trip. */
    private mailboxLoader(ctx: EasCommandContext): () => Promise<Mailbox> {
        let cached: Mailbox | undefined;
        return async () => {
            if (!cached) {
                cached = await this.mailboxRepo!.findOne(ctx.mailboxUid, { ignoreACL: true });
                if (!cached) {
                    throw new ApiError(ApiErrors.NOT_FOUND, 404, "The caller's own mailbox no longer exists.");
                }
            }
            return cached;
        };
    }

    public async handle(ctx: EasCommandContext): Promise<WbxmlElement | undefined> {
        const collections = ctx.request ? findChild(ctx.request, "Collections") : undefined;
        const collectionEls = collections ? findChildren(collections, "Collection") : [];
        if (collectionEls.length === 0) {
            return element(WbxmlCodePage.AirSync, "Sync", [textElement(WbxmlCodePage.AirSync, "Status", "3")]);
        }

        const collectionElements: WbxmlElement[] = [];
        // Accumulated across every collection below, then written in exactly ONE persistDeviceSyncState call
        // after the loop - never one call per collection (see this class's own doc comment on why).
        let folderSyncKeys: Record<string, string> | undefined;
        let folderCollectionClasses: Record<string, string> | undefined;

        const getMailbox = this.mailboxLoader(ctx);
        for (const collectionEl of collectionEls) {
            const result = await this.processCollection(ctx, collectionEl, getMailbox);
            collectionElements.push(result.collectionElement);
            if (result.folderUid && result.newSyncKey) {
                folderSyncKeys = {
                    ...(folderSyncKeys ?? ctx.deviceSyncState.folderSyncKeys),
                    [result.folderUid]: result.newSyncKey,
                };
            }
            if (result.folderUid && result.rememberedClass) {
                folderCollectionClasses = {
                    ...(folderCollectionClasses ?? ctx.deviceSyncState.folderCollectionClasses ?? {}),
                    [result.folderUid]: result.rememberedClass,
                };
            }
        }

        if (folderSyncKeys || folderCollectionClasses) {
            await persistDeviceSyncState(ctx.deviceSyncState, ctx.deviceSyncStateRepo, {
                ...(folderSyncKeys ? { folderSyncKeys } : {}),
                ...(folderCollectionClasses ? { folderCollectionClasses } : {}),
            });
        }

        return element(WbxmlCodePage.AirSync, "Sync", [
            element(WbxmlCodePage.AirSync, "Collections", collectionElements),
        ]);
    }

    /** Processes one `<Collection>` from the request into its own `<Collection>` response element, plus (when
     * this round advanced anything) the `folderUid`/new `SyncKey`/remembered `Class` for `handle()` to fold
     * into its single end-of-request `persistDeviceSyncState` call - this method itself never persists
     * anything, so it's safe to call once per collection in a request without the write-batching hazard
     * `EasSyncKeyUtils.persistDeviceSyncState`'s doc comment describes. */
    private async processCollection(
        ctx: EasCommandContext,
        collectionEl: WbxmlElement,
        getMailbox: () => Promise<Mailbox>,
    ): Promise<{ collectionElement: WbxmlElement; folderUid?: string; newSyncKey?: string; rememberedClass?: string }> {
        const requestedClass: string | undefined = childText(collectionEl, "Class");
        const folderUid: string | undefined = childText(collectionEl, "CollectionId");
        const clientSyncKey: string | undefined = childText(collectionEl, "SyncKey");

        // Class is only required on a collection's first (SyncKey "0") request - see this class's own doc
        // comment. A folder never previously synced has no remembered value to fall back to, so omitting Class
        // there still (correctly) falls through to the "missing" branch below.
        const collectionClass: string | undefined =
            requestedClass ?? (folderUid ? ctx.deviceSyncState.folderCollectionClasses?.[folderUid] : undefined);
        if (!collectionClass || !folderUid) {
            return { collectionElement: this.collectionResponse(collectionClass, folderUid, "4", clientSyncKey) };
        }

        const repo: RepoUtils<any> | undefined = this.repos.get(collectionClass);
        const adapter: EasCollectionSyncAdapter<any> | undefined = this.adapters.get(collectionClass);
        if (!repo || !adapter) {
            return { collectionElement: this.collectionResponse(collectionClass, folderUid, "4", clientSyncKey) };
        }

        const storedSyncKey: string | undefined = ctx.deviceSyncState.folderSyncKeys[folderUid];
        const resolution = resolveSyncKey(clientSyncKey, storedSyncKey);

        if (resolution.kind === "invalid") {
            return { collectionElement: this.collectionResponse(collectionClass, folderUid, "3", undefined) };
        }

        if (resolution.kind === "initial") {
            // Same epoch-not-"now" reasoning as FolderSyncCommand's own initial-sync branch: the client's next
            // request (echoing this key) is its true first full sync of this folder and must see every
            // existing item as an Add, not just ones modified after this handshake started.
            const newKey = formatSyncKey({ generation: 1, watermark: new Date(0) });
            return {
                collectionElement: this.collectionResponse(collectionClass, folderUid, "1", newKey),
                folderUid,
                newSyncKey: newKey,
                rememberedClass: requestedClass,
            };
        }

        // Computed against the OLD watermark, BEFORE this round's own client-originated writes below are
        // applied - this is what stops a client's own fresh Add/Change/Delete from being echoed straight back
        // as a Commands/Add|Change|Delete in this SAME response.
        const changes = await computeChanges(repo, "folderUid", folderUid, resolution.key.watermark, this.windowSize);

        // Process the client's own Commands (if any) - after the read above, before computing the new SyncKey
        // below (which must cover these writes too, or the NEXT round would re-report them as incoming
        // server-side changes).
        const requestCommands = findChild(collectionEl, "Commands");
        const responseEntries: WbxmlElement[] = [];
        let maxWriteWatermark: Date | undefined;
        const note = (date: Date | undefined) => {
            if (date && (!maxWriteWatermark || date > maxWriteWatermark)) maxWriteWatermark = date;
        };
        if (requestCommands) {
            for (const el of findChildren(requestCommands, "Add")) {
                const outcome = await this.applyAdd(adapter, repo, ctx.mailboxUid, folderUid, el, getMailbox);
                if (outcome.response) responseEntries.push(outcome.response);
                note(outcome.writtenAt);
            }
            for (const el of findChildren(requestCommands, "Change")) {
                const outcome = await this.applyChange(adapter, repo, el);
                if (outcome.response) responseEntries.push(outcome.response);
                note(outcome.writtenAt);
            }
            for (const el of findChildren(requestCommands, "Delete")) {
                const outcome = await this.applyDelete(repo, el);
                if (outcome.response) responseEntries.push(outcome.response);
                note(outcome.writtenAt);
            }
        }

        // Only ever extends the watermark forward past what `computeChanges` itself already determined - never
        // jumps all the way to "now" unconditionally, which would silently skip over not-yet-enumerated
        // pending changes whenever `changes.moreAvailable` is true.
        const newWatermark =
            maxWriteWatermark && maxWriteWatermark > changes.newWatermark ? maxWriteWatermark : changes.newWatermark;
        const newKey = formatSyncKey({ generation: resolution.key.generation + 1, watermark: newWatermark });

        const totalChanges: number = changes.adds.length + changes.changes.length + changes.deletes.length;
        if (totalChanges === 0 && responseEntries.length === 0) {
            return {
                collectionElement: this.collectionResponse(collectionClass, folderUid, "1", newKey),
                folderUid,
                newSyncKey: newKey,
                rememberedClass: requestedClass,
            };
        }

        const commandElements: WbxmlElement[] = [
            ...changes.adds.map((item) => this.itemToCommandElement("Add", adapter, item)),
            ...changes.changes.map((item) => this.itemToCommandElement("Change", adapter, item)),
            ...changes.deletes.map((item) =>
                element(WbxmlCodePage.AirSync, "Delete", [textElement(WbxmlCodePage.AirSync, "ServerId", item.uid)]),
            ),
        ];

        return {
            collectionElement: this.collectionResponse(collectionClass, folderUid, "1", newKey, [
                ...(changes.moreAvailable ? [element(WbxmlCodePage.AirSync, "MoreAvailable", [])] : []),
                ...(commandElements.length > 0 ? [element(WbxmlCodePage.AirSync, "Commands", commandElements)] : []),
                ...(responseEntries.length > 0 ? [element(WbxmlCodePage.AirSync, "Responses", responseEntries)] : []),
            ]),
            folderUid,
            newSyncKey: newKey,
            rememberedClass: requestedClass,
        };
    }

    private itemToCommandElement(kind: "Add" | "Change", adapter: EasCollectionSyncAdapter<any>, item: RecoverableBaseEntity): WbxmlElement {
        return element(WbxmlCodePage.AirSync, kind, [
            textElement(WbxmlCodePage.AirSync, "ServerId", item.uid),
            adapter.toApplicationData(item),
        ]);
    }

    /** One client-originated command's outcome: `response` is a `Responses/{Add,Change,Delete}` entry to
     * include (per MS-ASCMD, always present for `Add`, only present on failure for `Change`/`Delete`);
     * `writtenAt` is the resulting `dateModified` of whatever was actually written, used to advance the
     * persisted watermark past this round's own writes (see `handle()`'s own comment on why). */
    private addResponseElement(clientId: string | undefined, serverId: string | undefined, status: string): WbxmlElement {
        return element(WbxmlCodePage.AirSync, "Add", [
            ...(clientId ? [textElement(WbxmlCodePage.AirSync, "ClientId", clientId)] : []),
            ...(serverId ? [textElement(WbxmlCodePage.AirSync, "ServerId", serverId)] : []),
            textElement(WbxmlCodePage.AirSync, "Status", status),
        ]);
    }

    private statusResponseElement(kind: "Change" | "Delete", serverId: string, status: string): WbxmlElement {
        return element(WbxmlCodePage.AirSync, kind, [
            textElement(WbxmlCodePage.AirSync, "ServerId", serverId),
            textElement(WbxmlCodePage.AirSync, "Status", status),
        ]);
    }

    private async applyAdd(
        adapter: EasCollectionSyncAdapter<any>,
        repo: RepoUtils<any>,
        mailboxUid: string,
        folderUid: string,
        el: WbxmlElement,
        getMailbox: () => Promise<Mailbox>,
    ): Promise<{ response?: WbxmlElement; writtenAt?: Date }> {
        const clientId = childText(el, "ClientId");
        const appData = findChild(el, "ApplicationData");
        // [MS-ASCMD] "Add (Sync)": "The Add element cannot be used to add any non-draft email items from the
        // client to the server" - this pragmatic subset extends that same Status 6 to every collection whose
        // adapter has no fromApplicationData at all, rather than special-casing "Email" by name.
        if (!adapter.fromApplicationData || !appData) {
            return { response: this.addResponseElement(clientId, undefined, "6") };
        }
        try {
            const defaults = adapter.newEntityDefaults ? adapter.newEntityDefaults(await getMailbox()) : {};
            const partial = await adapter.fromApplicationData(appData);
            const created = await repo.create({ ...defaults, ...partial, mailboxUid, folderUid } as any, { ignoreACL: true });
            return {
                response: this.addResponseElement(clientId, created.uid, "1"),
                writtenAt: created.dateModified,
            };
        } catch {
            // A malformed/invalid item (bad enum value, missing required field like Calendar's OrganizerEmail,
            // ...) - Status 6 is [MS-ASCMD]'s own designated code for exactly this ("client/server conversion
            // error... client has sent a malformed or invalid item").
            return { response: this.addResponseElement(clientId, undefined, "6") };
        }
    }

    private async applyChange(
        adapter: EasCollectionSyncAdapter<any>,
        repo: RepoUtils<any>,
        el: WbxmlElement,
    ): Promise<{ response?: WbxmlElement; writtenAt?: Date }> {
        const serverId = childText(el, "ServerId");
        if (!serverId) {
            return {};
        }
        if (!adapter.fromApplicationData) {
            return { response: this.statusResponseElement("Change", serverId, "6") };
        }
        const existing = await repo.findOne(serverId, { ignoreACL: true });
        if (!existing) {
            return { response: this.statusResponseElement("Change", serverId, "8") };
        }
        const appData = findChild(el, "ApplicationData");
        if (!appData) {
            return { response: this.statusResponseElement("Change", serverId, "6") };
        }
        try {
            const partial = await adapter.fromApplicationData(appData, existing);
            const updated = await repo.update(
                { uid: existing.uid, version: existing.version, ...partial },
                existing,
                { ignoreACL: true },
            );
            // Success is silent per [MS-ASCMD]'s own "the client only receives responses for ... failed
            // changes" rule - no response entry.
            return { writtenAt: updated.dateModified };
        } catch (err: any) {
            if (err instanceof ApiError && err.code === ApiErrors.INVALID_OBJECT_VERSION) {
                return { response: this.statusResponseElement("Change", serverId, "7") };
            }
            return { response: this.statusResponseElement("Change", serverId, "6") };
        }
    }

    private async applyDelete(repo: RepoUtils<any>, el: WbxmlElement): Promise<{ response?: WbxmlElement; writtenAt?: Date }> {
        const serverId = childText(el, "ServerId");
        if (!serverId) {
            return {};
        }
        const existing = await repo.findOne(serverId, { ignoreACL: true });
        if (!existing) {
            return { response: this.statusResponseElement("Delete", serverId, "8") };
        }
        try {
            const writtenAt = new Date();
            await repo.delete(existing.uid, { ignoreACL: true });
            // Success is silent, same rule as applyChange.
            return { writtenAt };
        } catch {
            return { response: this.statusResponseElement("Delete", serverId, "6") };
        }
    }

    /** Builds one `<Collection>` response element - `handle()` collects one of these per request `<Collection>`
     * and wraps the whole set in a single `<Sync><Collections>`. */
    private collectionResponse(
        collectionClass: string | undefined,
        folderUid: string | undefined,
        status: string,
        syncKey: string | undefined,
        extra: WbxmlElement[] = [],
    ): WbxmlElement {
        return element(WbxmlCodePage.AirSync, "Collection", [
            ...(collectionClass ? [textElement(WbxmlCodePage.AirSync, "Class", collectionClass)] : []),
            ...(syncKey ? [textElement(WbxmlCodePage.AirSync, "SyncKey", syncKey)] : []),
            ...(folderUid ? [textElement(WbxmlCodePage.AirSync, "CollectionId", folderUid)] : []),
            textElement(WbxmlCodePage.AirSync, "Status", status),
            ...extra,
        ]);
    }
}
