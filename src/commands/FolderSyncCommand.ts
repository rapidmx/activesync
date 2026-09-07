///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import { ApiError, ObjectDecorators } from "@rapidrest/core";
import { ApiErrorMessages, ApiErrors, ObjectFactory, RepoUtils } from "@rapidrest/service-core";
import { WbxmlCodePage } from "../codec/WbxmlCodePages.js";
import { childText, element, textElement, type WbxmlElement } from "../codec/WbxmlElement.js";
import { computeChanges, formatSyncKey, persistDeviceSyncState, resolveSyncKey } from "../EasSyncKeyUtils.js";
import type { EasCommandContext, EasCommandHandler } from "../EasCommandHandler.js";
import { Folder, FolderType } from "@rapidmx/restapi";
const { Config, Init } = ObjectDecorators;

/** Maps this library's `FolderType` to the closest MS-ASCMD folder type code. Several of this app's types
 * collapse onto the spec's "default well-known folder" codes rather than distinguishing a default folder from
 * a second, user-created folder of the same content type (e.g. a second calendar also reports as `8`) - a
 * deliberate pragmatic-subset simplification, not an oversight; see `BaseFolderRoute`'s own precedent for
 * this library's general stance on this kind of gap. */
const FOLDER_TYPE_CODES: Record<FolderType, string> = {
    [FolderType.INBOX]: "2",
    [FolderType.DRAFTS]: "3",
    [FolderType.DELETED_ITEMS]: "4",
    [FolderType.SENT_ITEMS]: "5",
    [FolderType.OUTBOX]: "6",
    [FolderType.TASKS]: "7",
    [FolderType.CALENDAR]: "8",
    [FolderType.CONTACTS]: "9",
    [FolderType.NOTES]: "10",
    [FolderType.JUNK]: "12",
    [FolderType.USER]: "12",
};

/** EAS represents "no parent" (a top-level folder) as the literal string `"0"`, not an absent element. */
const ROOT_PARENT_ID = "0";

/** The (somewhat arbitrary, since `FolderSync` covers the whole mailbox's folder hierarchy rather than one
 * particular folder) key `DeviceSyncState.folderSyncKeys` is stored under for this cursor - distinct from any
 * real `Folder.uid`, which is exactly why using the mailbox's own uid here would be ambiguous. */
const FOLDER_HIERARCHY_CURSOR_KEY = "$foldersync";

/** Caps how many folder changes are enumerated per round - real mailboxes rarely have more than a few dozen
 * folders, so this is generous, not a real-world binding constraint; it exists so `computeChanges()`'s
 * `MoreAvailable` mechanism is exercised the same way it will be for `SyncCommand`'s much larger item
 * collections. */
const DEFAULT_WINDOW_SIZE = 512;

/**
 * Handles EAS `FolderSync`: enumerates `Add`/`Update`/`Delete`s for the caller's mailbox's `Folder` hierarchy
 * since the device's last `FolderSync`, using the shared watermark-based cursor mechanism in
 * `EasSyncKeyUtils.ts` (scoped by `mailboxUid` over the `Folder` collection, rather than `folderUid` over a
 * per-folder item collection the way `SyncCommand` will be).
 *
 * `folderClass` is supplied by the Mongo/SQL concrete subclasses, following the exact one-line-per-backend
 * pattern used throughout this library's other routes/jobs.
 *
 * @author Jean-Philippe Steinmetz
 */
export abstract class FolderSyncCommand<F extends Folder> implements EasCommandHandler {
    public readonly command = "FolderSync";

    protected abstract folderClass: any;

    @Config("mail:eas:foldersync_window_size", DEFAULT_WINDOW_SIZE)
    private windowSize: number = DEFAULT_WINDOW_SIZE;

    // Automatically injected by ObjectFactory on instantiation
    private _objectFactory?: ObjectFactory;

    private folderRepo?: RepoUtils<F>;

    @Init
    public async init(): Promise<void> {
        this.folderRepo = await this._objectFactory!.newInstance(RepoUtils, {
            name: this.folderClass.name,
            args: [this.folderClass],
        });
    }

    public async handle(ctx: EasCommandContext): Promise<WbxmlElement | undefined> {
        if (!this.folderRepo) {
            throw new ApiError(ApiErrors.INTERNAL_ERROR, 500, ApiErrorMessages.INTERNAL_ERROR);
        }

        const clientSyncKey: string | undefined = ctx.request ? childText(ctx.request, "SyncKey") : undefined;
        const storedSyncKey: string | undefined = ctx.deviceSyncState.folderSyncKeys[FOLDER_HIERARCHY_CURSOR_KEY];
        const resolution = resolveSyncKey(clientSyncKey, storedSyncKey);

        if (resolution.kind === "invalid") {
            return element(WbxmlCodePage.FolderHierarchy, "FolderSync", [
                textElement(WbxmlCodePage.FolderHierarchy, "Status", "3"),
            ]);
        }

        if (resolution.kind === "initial") {
            // Per spec: the first response to SyncKey "0" never returns items itself, only establishes a
            // cursor - but that cursor's watermark must be the epoch, not "now": the client's *next* request
            // (with this key) is its true first full sync and must report every existing folder as an Add,
            // including ones that existed and were last modified long before this handshake ever started.
            // Watermarking at "now" here would silently skip all of those (an epoch-old folder never appears
            // as "modified after now"), which is exactly backwards for a brand-new device's first sync.
            const newKey = formatSyncKey({ generation: 1, watermark: new Date(0) });
            await this.persistSyncKey(ctx, newKey);
            return element(WbxmlCodePage.FolderHierarchy, "FolderSync", [
                textElement(WbxmlCodePage.FolderHierarchy, "Status", "1"),
                textElement(WbxmlCodePage.FolderHierarchy, "SyncKey", newKey),
            ]);
        }

        const changes = await computeChanges(this.folderRepo, "mailboxUid", ctx.mailboxUid, resolution.key.watermark, this.windowSize);
        const newKey = formatSyncKey({ generation: resolution.key.generation + 1, watermark: changes.newWatermark });
        await this.persistSyncKey(ctx, newKey);

        const totalChanges: number = changes.adds.length + changes.changes.length + changes.deletes.length;
        if (totalChanges === 0) {
            return element(WbxmlCodePage.FolderHierarchy, "FolderSync", [
                textElement(WbxmlCodePage.FolderHierarchy, "Status", "1"),
                textElement(WbxmlCodePage.FolderHierarchy, "SyncKey", newKey),
            ]);
        }

        const changeElements: WbxmlElement[] = [
            ...changes.adds.map((folder) => this.folderToChangeElement("Add", folder)),
            ...changes.changes.map((folder) => this.folderToChangeElement("Update", folder)),
            ...changes.deletes.map((folder) =>
                element(WbxmlCodePage.FolderHierarchy, "Delete", [
                    textElement(WbxmlCodePage.FolderHierarchy, "ServerId", folder.uid),
                ]),
            ),
        ];

        return element(WbxmlCodePage.FolderHierarchy, "FolderSync", [
            textElement(WbxmlCodePage.FolderHierarchy, "Status", "1"),
            textElement(WbxmlCodePage.FolderHierarchy, "SyncKey", newKey),
            element(WbxmlCodePage.FolderHierarchy, "Changes", [
                textElement(WbxmlCodePage.FolderHierarchy, "Count", String(totalChanges)),
                ...changeElements,
            ]),
        ]);
    }

    private folderToChangeElement(kind: "Add" | "Update", folder: F): WbxmlElement {
        return element(WbxmlCodePage.FolderHierarchy, kind, [
            textElement(WbxmlCodePage.FolderHierarchy, "ServerId", folder.uid),
            textElement(WbxmlCodePage.FolderHierarchy, "ParentId", folder.parentFolderUid ?? ROOT_PARENT_ID),
            textElement(WbxmlCodePage.FolderHierarchy, "DisplayName", folder.name),
            /* v8 ignore next -- unreachable via real data: FOLDER_TYPE_CODES has an entry for every FolderType
               enum value, so the `??` fallback only guards a future enum member added to one without the
               other; `folder.type` can never carry a value outside the enum. */
            textElement(WbxmlCodePage.FolderHierarchy, "Type", FOLDER_TYPE_CODES[folder.type] ?? FOLDER_TYPE_CODES[FolderType.USER]),
        ]);
    }

    private async persistSyncKey(ctx: EasCommandContext, newKey: string): Promise<void> {
        const folderSyncKeys = { ...ctx.deviceSyncState.folderSyncKeys, [FOLDER_HIERARCHY_CURSOR_KEY]: newKey };
        await persistDeviceSyncState(ctx.deviceSyncState, ctx.deviceSyncStateRepo, { folderSyncKeys });
    }
}
