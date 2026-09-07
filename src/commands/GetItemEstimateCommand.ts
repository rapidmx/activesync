///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import { ObjectDecorators } from "@rapidrest/core";
import { ObjectFactory, RepoUtils } from "@rapidrest/service-core";
import { RecoverableRepoUtils } from "@rapidmx/restapi";
import { WbxmlCodePage } from "../codec/WbxmlCodePages.js";
import { childText, element, findChild, findChildren, textElement, type WbxmlElement } from "../codec/WbxmlElement.js";
import { computeChanges, resolveSyncKey } from "../EasSyncKeyUtils.js";
import type { EasCommandContext, EasCommandHandler } from "../EasCommandHandler.js";
const { Config, Init } = ObjectDecorators;

/** Caps how many changes `computeChanges()` will actually enumerate (and therefore count) per collection for
 * an already-synced folder - a real estimate, not a precise unbounded count, matching the command's own name;
 * a folder with more pending changes than this reports exactly this many, not the true total. Deliberately
 * separate from `SyncCommand`'s own `mail:eas:sync_window_size` - the two commands have no reason to share one
 * config knob just because they happen to reuse the same underlying enumeration helper. */
const DEFAULT_MAX_COUNT = 512;

/** Binds one MS-ASCMD `Class` value to the concrete entity class this command counts against - a lighter
 * version of `SyncCommand`'s own `SyncCollectionBinding` (no adapter needed at all, since `GetItemEstimate`
 * never serializes an item, only counts them). Supplied by the Mongo/SQL concrete subclasses. */
export interface EstimateCollectionBinding {
    entityClass: any;
}

/**
 * Handles EAS `GetItemEstimate`: reports, per requested `<Collection>`, an estimated count of the
 * `Add`/`Change`/`Delete`s a subsequent `Sync` of that collection would return - read-only, it never issues or
 * consumes a `SyncKey` itself.
 *
 * The modern (14.0+) request/response reuses `WbxmlCodePage.AirSync`'s own `Collections`/`Collection`/`Class`/
 * `CollectionId`/`SyncKey` via `SWITCH_PAGE` rather than this page's own legacy (`Folders`/`Folder`/`FolderId`)
 * shape - see `WbxmlCodePages.ts`'s own doc comment on `WbxmlCodePage.ItemEstimate` for why, and
 * `ItemOperationsCommand.fetchMessage`'s identical cross-page-reuse precedent.
 *
 * A `SyncKey` of `"0"` (or one this device has never synced this folder with before) reports the folder's
 * total live item count - what a first `Sync` would report as `Add`s. Otherwise reuses `EasSyncKeyUtils.
 * computeChanges()` (the same enumeration `SyncCommand` itself uses), capped at `DEFAULT_MAX_COUNT` - see its
 * own doc comment for why this is a real, documented approximation on a very active folder rather than a
 * precise unbounded count.
 *
 * @author Jean-Philippe Steinmetz
 */
export abstract class GetItemEstimateCommand implements EasCommandHandler {
    public readonly command = "GetItemEstimate";

    protected abstract collectionBindings: Record<string, EstimateCollectionBinding>;

    @Config("mail:eas:item_estimate_max_count", DEFAULT_MAX_COUNT)
    private maxCount: number = DEFAULT_MAX_COUNT;

    // Automatically injected by ObjectFactory on instantiation
    private _objectFactory?: ObjectFactory;

    private repos = new Map<string, RepoUtils<any>>();

    @Init
    public async init(): Promise<void> {
        for (const [collectionClass, binding] of Object.entries(this.collectionBindings)) {
            this.repos.set(
                collectionClass,
                await this._objectFactory!.newInstance(RecoverableRepoUtils, {
                    name: binding.entityClass.name,
                    args: [binding.entityClass],
                }),
            );
        }
    }

    public async handle(ctx: EasCommandContext): Promise<WbxmlElement | undefined> {
        const collections = ctx.request ? findChild(ctx.request, "Collections") : undefined;
        const collectionEls = collections ? findChildren(collections, "Collection") : [];
        if (collectionEls.length === 0) {
            return element(WbxmlCodePage.ItemEstimate, "GetItemEstimate", [
                element(WbxmlCodePage.ItemEstimate, "Response", [
                    textElement(WbxmlCodePage.ItemEstimate, "Status", "2"),
                ]),
            ]);
        }

        const responses: WbxmlElement[] = [];
        for (const collectionEl of collectionEls) {
            responses.push(await this.estimateCollection(ctx, collectionEl));
        }

        return element(WbxmlCodePage.ItemEstimate, "GetItemEstimate", responses);
    }

    private async estimateCollection(ctx: EasCommandContext, collectionEl: WbxmlElement): Promise<WbxmlElement> {
        const collectionClass: string | undefined = childText(collectionEl, "Class");
        const folderUid: string | undefined = childText(collectionEl, "CollectionId");
        const clientSyncKey: string | undefined = childText(collectionEl, "SyncKey");

        const repo = collectionClass ? this.repos.get(collectionClass) : undefined;
        if (!collectionClass || !folderUid || !repo) {
            // Status 2 ("Invalid collection") per [MS-ASCMD] - the request named a collection this device
            // hasn't (or can't) sync.
            return element(WbxmlCodePage.ItemEstimate, "Response", [
                textElement(WbxmlCodePage.ItemEstimate, "Status", "2"),
            ]);
        }

        const storedSyncKey = ctx.deviceSyncState.folderSyncKeys[folderUid];
        const resolution = resolveSyncKey(clientSyncKey, storedSyncKey);
        if (resolution.kind === "invalid") {
            return element(WbxmlCodePage.ItemEstimate, "Response", [
                textElement(WbxmlCodePage.ItemEstimate, "Status", "2"),
                this.collectionElement(collectionClass, folderUid, undefined),
            ]);
        }

        // A brand-new (or never-synced-by-this-device) folder: every live item would be reported as an Add on
        // the device's first real Sync round - a plain count() of non-deleted rows (excluded by default; see
        // computeChanges()'s own doc comment on this query builder behavior), not computeChanges() itself,
        // which would incorrectly also count this folder's entire soft-deleted history (irrelevant to a client
        // that has never seen any of those rows in the first place).
        let count: number;
        if (resolution.kind === "initial") {
            count = await repo.count({ folderUid } as any, { ignoreACL: true });
        } else {
            const changes = await computeChanges(repo, "folderUid", folderUid, resolution.key.watermark, this.maxCount);
            count = changes.adds.length + changes.changes.length + changes.deletes.length;
        }

        return element(WbxmlCodePage.ItemEstimate, "Response", [
            textElement(WbxmlCodePage.ItemEstimate, "Status", "1"),
            this.collectionElement(collectionClass, folderUid, count),
        ]);
    }

    private collectionElement(collectionClass: string, folderUid: string, estimate: number | undefined): WbxmlElement {
        return element(WbxmlCodePage.AirSync, "Collection", [
            textElement(WbxmlCodePage.AirSync, "Class", collectionClass),
            textElement(WbxmlCodePage.AirSync, "CollectionId", folderUid),
            ...(estimate !== undefined ? [textElement(WbxmlCodePage.ItemEstimate, "Estimate", String(estimate))] : []),
        ]);
    }
}
