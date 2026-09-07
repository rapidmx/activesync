///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import { ObjectDecorators } from "@rapidrest/core";
import { ObjectFactory, RepoUtils, type RecoverableBaseEntity } from "@rapidrest/service-core";
import { WbxmlCodePage } from "../codec/WbxmlCodePages.js";
import { childText, element, findChild, textElement, type WbxmlElement } from "../codec/WbxmlElement.js";
import { computeChanges, formatSyncKey, resolveSyncKey } from "../EasSyncKeyUtils.js";
import type { EasCommandContext, EasCommandHandler } from "../EasCommandHandler.js";
import type { EasCollectionSyncAdapter } from "../adapters/EasCollectionSyncAdapter.js";
const { Config, Init } = ObjectDecorators;

/** Caps how many item changes are enumerated per `Sync` round - a real device-visible "MoreAvailable" trigger
 * for a busy folder, not a real-world binding constraint (unlike `FolderSyncCommand`'s much smaller folder
 * hierarchy, an Inbox can easily exceed this in one round). */
const DEFAULT_WINDOW_SIZE = 100;

/** Binds one MS-ASCMD `Class` value (`"Email"`, `"Contacts"`, ...) to the concrete entity class `SyncCommand`
 * should build a `RepoUtils` for, and the adapter that maps that entity to/from `ApplicationData`. Supplied by
 * the Mongo/SQL concrete subclasses, one map entry per collection type currently supported (only `Email` as of
 * this step; `Contacts`/`Calendar`/`Tasks` land in later steps by adding more entries, not by changing this
 * class). */
export interface SyncCollectionBinding<T extends RecoverableBaseEntity> {
    entityClass: any;
    adapter: EasCollectionSyncAdapter<T>;
}

/**
 * Handles EAS `Sync`: enumerates `Add`/`Change`/`Delete`s for a single folder's contents since the device's last
 * `Sync` of that folder, using the same watermark-based cursor mechanism `FolderSyncCommand` uses (via
 * `EasSyncKeyUtils`), scoped by `folderUid` instead of `mailboxUid`, and keyed per-folder in
 * `DeviceSyncState.folderSyncKeys` (the `CollectionId` a client sends *is* the `folderUid` - this library never
 * invents a separate collection identifier).
 *
 * **Pragmatic subset, deliberately not the full MS-ASCMD `Sync` surface**:
 * - Exactly one `<Collection>` per request is honored; a request batching several is answered only for the
 * first (real clients commonly send one collection per request anyway when working through an initial sync
 * backlog, and this mirrors `FolderSyncCommand`'s own single-hierarchy scope).
 * - `Class` must be present on every request (the spec only requires it on the first, `SyncKey "0"`, request
 * for a collection, allowing it to be omitted afterward on the assumption the server remembers it) - a
 * client that omits it on a later request is rejected with a protocol-error `Status` rather than the server
 * tracking a `folderUid -> Class` mapping of its own. A known, documented limitation, not silently dropped.
 * - Client-originated `Add`/`Change`/`Delete` commands (a device editing/deleting an item locally and pushing
 * that back) are not accepted - this pragmatic subset is read/enumerate-only from the server's perspective
 * for these collections (mail composition goes through `SendMailCommand`, not `Sync`).
 * - Only a body preview is returned per item (see `EmailSyncAdapter`'s own doc comment) - full body content is
 * fetched separately via `ItemOperationsCommand`.
 *
 * @author Jean-Philippe Steinmetz
 */
export abstract class SyncCommand implements EasCommandHandler {
    public readonly command = "Sync";

    protected abstract collectionBindings: Record<string, SyncCollectionBinding<any>>;

    @Config("mail:eas:sync_window_size", DEFAULT_WINDOW_SIZE)
    private windowSize: number = DEFAULT_WINDOW_SIZE;

    // Automatically injected by ObjectFactory on instantiation
    private _objectFactory?: ObjectFactory;

    private repos = new Map<string, RepoUtils<any>>();

    @Init
    public async init(): Promise<void> {
        for (const [collectionClass, binding] of Object.entries(this.collectionBindings)) {
            this.repos.set(
                collectionClass,
                await this._objectFactory!.newInstance(RepoUtils, {
                    name: binding.entityClass.name,
                    args: [binding.entityClass],
                }),
            );
        }
    }

    public async handle(ctx: EasCommandContext): Promise<WbxmlElement | undefined> {
        const collections = ctx.request ? findChild(ctx.request, "Collections") : undefined;
        const collection = collections ? findChild(collections, "Collection") : undefined;
        if (!collection) {
            return element(WbxmlCodePage.AirSync, "Sync", [textElement(WbxmlCodePage.AirSync, "Status", "3")]);
        }

        const collectionClass: string | undefined = childText(collection, "Class");
        const folderUid: string | undefined = childText(collection, "CollectionId");
        const clientSyncKey: string | undefined = childText(collection, "SyncKey");
        if (!collectionClass || !folderUid) {
            return this.collectionResponse(collectionClass, folderUid, "4", clientSyncKey);
        }

        const binding: SyncCollectionBinding<any> | undefined = this.collectionBindings[collectionClass];
        const repo: RepoUtils<any> | undefined = this.repos.get(collectionClass);
        if (!binding || !repo) {
            return this.collectionResponse(collectionClass, folderUid, "4", clientSyncKey);
        }

        const storedSyncKey: string | undefined = ctx.deviceSyncState.folderSyncKeys[folderUid];
        const resolution = resolveSyncKey(clientSyncKey, storedSyncKey);

        if (resolution.kind === "invalid") {
            return this.collectionResponse(collectionClass, folderUid, "3", undefined);
        }

        if (resolution.kind === "initial") {
            // Same epoch-not-"now" reasoning as FolderSyncCommand's own initial-sync branch: the client's next
            // request (echoing this key) is its true first full sync of this folder and must see every
            // existing item as an Add, not just ones modified after this handshake started.
            const newKey = formatSyncKey({ generation: 1, watermark: new Date(0) });
            await this.persistSyncKey(ctx, folderUid, newKey);
            return this.collectionResponse(collectionClass, folderUid, "1", newKey);
        }

        const changes = await computeChanges(repo, "folderUid", folderUid, resolution.key.watermark, this.windowSize);
        const newKey = formatSyncKey({ generation: resolution.key.generation + 1, watermark: changes.newWatermark });
        await this.persistSyncKey(ctx, folderUid, newKey);

        const totalChanges: number = changes.adds.length + changes.changes.length + changes.deletes.length;
        if (totalChanges === 0) {
            return this.collectionResponse(collectionClass, folderUid, "1", newKey);
        }

        const commandElements: WbxmlElement[] = [
            ...changes.adds.map((item) => this.itemToCommandElement("Add", binding.adapter, item)),
            ...changes.changes.map((item) => this.itemToCommandElement("Change", binding.adapter, item)),
            ...changes.deletes.map((item) =>
                element(WbxmlCodePage.AirSync, "Delete", [textElement(WbxmlCodePage.AirSync, "ServerId", item.uid)]),
            ),
        ];

        return this.collectionResponse(collectionClass, folderUid, "1", newKey, [
            ...(changes.moreAvailable ? [element(WbxmlCodePage.AirSync, "MoreAvailable", [])] : []),
            element(WbxmlCodePage.AirSync, "Commands", commandElements),
        ]);
    }

    private itemToCommandElement(kind: "Add" | "Change", adapter: EasCollectionSyncAdapter<any>, item: RecoverableBaseEntity): WbxmlElement {
        return element(WbxmlCodePage.AirSync, kind, [
            textElement(WbxmlCodePage.AirSync, "ServerId", item.uid),
            adapter.toApplicationData(item),
        ]);
    }

    private collectionResponse(
        collectionClass: string | undefined,
        folderUid: string | undefined,
        status: string,
        syncKey: string | undefined,
        extra: WbxmlElement[] = [],
    ): WbxmlElement {
        return element(WbxmlCodePage.AirSync, "Sync", [
            element(WbxmlCodePage.AirSync, "Collections", [
                element(WbxmlCodePage.AirSync, "Collection", [
                    ...(collectionClass ? [textElement(WbxmlCodePage.AirSync, "Class", collectionClass)] : []),
                    ...(syncKey ? [textElement(WbxmlCodePage.AirSync, "SyncKey", syncKey)] : []),
                    ...(folderUid ? [textElement(WbxmlCodePage.AirSync, "CollectionId", folderUid)] : []),
                    textElement(WbxmlCodePage.AirSync, "Status", status),
                    ...extra,
                ]),
            ]),
        ]);
    }

    private async persistSyncKey(ctx: EasCommandContext, folderUid: string, newKey: string): Promise<void> {
        const folderSyncKeys = { ...ctx.deviceSyncState.folderSyncKeys, [folderUid]: newKey };
        ctx.deviceSyncState.folderSyncKeys = folderSyncKeys;
        await ctx.deviceSyncStateRepo.update(
            { uid: ctx.deviceSyncState.uid, version: (ctx.deviceSyncState as any).version, folderSyncKeys } as any,
            ctx.deviceSyncState,
            { ignoreACL: true, skipPush: true },
        );
    }
}
