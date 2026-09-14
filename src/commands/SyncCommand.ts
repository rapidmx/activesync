///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import { ApiError, ObjectDecorators } from "@rapidrest/core";
import {
    ACLAction,
    ACLUtils,
    ApiErrorMessages,
    ApiErrors,
    ObjectFactory,
    RepoUtils,
    type RecoverableBaseEntity,
} from "@rapidrest/service-core";
import { findOrCreateWellKnownFolder, type Folder, FolderType, RecoverableRepoUtils, type Mailbox } from "@rapidmx/restapi";
import { WbxmlCodePage } from "../codec/WbxmlCodePages.js";
import { childText, element, findChild, findChildren, textElement, type WbxmlElement } from "../codec/WbxmlElement.js";
import { formatSyncKey } from "../EasSyncKeyUtils.js";
import {
    classForFolderType,
    cloneWorkingState,
    type CollectionWorkingState,
    enumerateCollection,
    filterPredicate,
    roundRecord,
    workingStateFromRound,
    workingStateFromRow,
} from "../EasCollectionSync.js";
import type { EasCommandContext, EasCommandHandler } from "../EasCommandHandler.js";
import type { EasCollectionSyncAdapter } from "../adapters/EasCollectionSyncAdapter.js";
import type { EasCollectionState } from "../models/EasCollectionState.js";
const { Config, Init, Inject, Logger } = ObjectDecorators;

/** Default most item changes reported per collection per `Sync` round. */
const DEFAULT_WINDOW_SIZE = 100;

/** [MS-ASCMD]'s own ceiling for `WindowSize`. */
const MAX_WINDOW_SIZE = 512;

/** Most `<Collection>`s one `Sync` request may carry - more is answered with a top-level Status 4. */
export const MAX_SYNC_COLLECTIONS = 300;

/** Most client `Add`/`Change`/`Delete` commands one collection of a `Sync` request may carry - more is answered
 * with that collection's Status 4, without applying any of them. */
export const MAX_SYNC_COMMANDS_PER_COLLECTION = 512;

/** Rows read per round from the stream of items outside a collection's folder (see `enumerateCollection`). */
const DEFAULT_MOVE_SCAN_LIMIT = 1000;

/** Slack subtracted from "now" when a collection is (re)started, for the out-of-folder cursor. */
const MOVE_CURSOR_SLACK_MS = 60_000;

/** Binds one MS-ASCMD `Class` value (`"Email"`, `"Contacts"`, ...) to the concrete entity class `SyncCommand`
 * should build a `RepoUtils` for, and the adapter class that maps that entity to/from `ApplicationData`.
 * Supplied by the Mongo/SQL concrete subclasses, one map entry per supported collection type. */
export interface SyncCollectionBinding<T extends RecoverableBaseEntity> {
    entityClass: any;
    adapterClass: any;
}

/** Everything one collection's round needs while applying client commands. */
interface CollectionRound {
    ctx: EasCommandContext;
    folder: Folder & { uid: string };
    collectionClass: string;
    adapter: EasCollectionSyncAdapter<any>;
    repo: RepoUtils<any>;
    working: CollectionWorkingState;
    /** Set when the client retried the previous round's `SyncKey`. */
    retry?: { removedIds: Set<string>; clientIds: Map<string, string> };
    clientIds: Map<string, string>;
    deletesAsMoves: boolean;
    getMailbox: () => Promise<Mailbox>;
}

/**
 * Handles EAS `Sync` for `Email`/`Contacts`/`Calendar`/`Tasks` folders.
 *
 * **Per-collection state** lives in its own `EasCollectionState` row per (mailbox, device, folder) - see that
 * model - rather than in `DeviceSyncState`, so concurrent `Sync`s of different folders never contend for one row.
 * Besides the issued `SyncKey`, the row records exactly which items the device holds (`serverIds`). That is what
 * makes the reported commands correct rather than guessed: an item the device doesn't hold is always an `Add`
 * (including on the first round after `SyncKey 0`), an item it holds is a `Change`, and an item it holds that has
 * been deleted *or moved to another folder* is a `Delete` - see `EasCollectionSync.enumerateCollection`.
 *
 * **Round order**: the client's own `Commands` are applied first, then server changes are enumerated. The device's
 * own writes are not echoed back: each successful `Add`/`Change` records the resulting `dateModified` in the row's
 * `echoes`, and a changed row still carrying exactly that timestamp is skipped. The cursor itself only ever advances
 * past rows actually enumerated, never past a pending server change.
 *
 * **Retries**: a client that never received a response re-sends the `SyncKey` it still holds. The row keeps the
 * previous round's key and delta (`previous`), so that key is accepted and the round is recomputed from the state
 * before it; an `Add` re-sent with the same `ClientId` is answered with the item created the first time, and a
 * `Delete` of an item that round already removed succeeds silently.
 *
 * **Options honoured**: `WindowSize` (capped by `mail:eas:sync_window_size` and 512), `FilterType` (age window for
 * `Email`/`Calendar`, incomplete-only for `Tasks`; applied to items the device doesn't hold yet - a request whose
 * `FilterType` differs from the one the collection was synced with gets Status 3 so the client re-syncs from 0),
 * `DeletesAsMoves` (default `true`: an `Email` delete moves the message to Deleted Items; a delete inside Deleted
 * Items, or with `DeletesAsMoves` `0`, deletes it) and `GetChanges` `0` (no server changes this round).
 *
 * **Access**: every `CollectionId` needs `READ` on the folder (otherwise Status 4, indistinguishable from an unknown
 * collection); `Add`/`Change`/`Delete` additionally need `CREATE`/`UPDATE`/`DELETE`, and a `ServerId` that resolves
 * to an item outside the synced folder is reported as not found (Status 8). An `Email` `Add` is only accepted in
 * a Drafts folder ([MS-ASCMD]: no non-draft email may be added by a client), and a new item's `mailboxUid` is the
 * folder's own mailbox, so an item added to a shared folder belongs to that folder's mailbox.
 *
 * Per `[MS-ASCMD]`, `Add` always gets a `Responses` entry; `Change`/`Delete` only on failure.
 *
 * @author Jean-Philippe Steinmetz
 */
export abstract class SyncCommand implements EasCommandHandler {
    public readonly command = "Sync";

    protected abstract collectionBindings: Record<string, SyncCollectionBinding<any>>;

    /** Supplied by the Mongo/SQL concrete subclasses. */
    protected abstract mailboxClass: any;
    protected abstract folderClass: any;
    protected abstract collectionStateClass: any;

    @Config("mail:eas:sync_window_size", DEFAULT_WINDOW_SIZE)
    private windowSize: number = DEFAULT_WINDOW_SIZE;

    protected moveScanLimit: number = DEFAULT_MOVE_SCAN_LIMIT;

    // Automatically injected by ObjectFactory on instantiation
    private _objectFactory?: ObjectFactory;

    @Inject(ACLUtils)
    private aclUtils?: ACLUtils;

    @Logger
    private logger: any;

    private repos = new Map<string, RepoUtils<any>>();
    private adapters = new Map<string, EasCollectionSyncAdapter<any>>();
    private mailboxRepo?: RepoUtils<any>;
    private folderRepo?: RecoverableRepoUtils<any>;
    private collectionStateRepo?: RepoUtils<any>;

    @Init
    public async init(): Promise<void> {
        this.mailboxRepo = await this._objectFactory!.newInstance(RepoUtils, {
            name: this.mailboxClass.name,
            args: [this.mailboxClass],
        });
        this.folderRepo = await this._objectFactory!.newInstance(RecoverableRepoUtils, {
            name: this.folderClass.name,
            args: [this.folderClass],
        });
        this.collectionStateRepo = await this._objectFactory!.newInstance(RepoUtils, {
            name: this.collectionStateClass.name,
            args: [this.collectionStateClass],
        });
        for (const [collectionClass, binding] of Object.entries(this.collectionBindings)) {
            // RecoverableRepoUtils: a soft-delete must bump `dateModified`/`version`, or the change stream this
            // class enumerates would never see it.
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

    /** Resolves the caller's own `Mailbox` at most once per request, and only if actually needed. */
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
        if (!this.aclUtils || !this.folderRepo || !this.collectionStateRepo) {
            throw new ApiError(ApiErrors.INTERNAL_ERROR, 500, ApiErrorMessages.INTERNAL_ERROR);
        }
        const collections = ctx.request ? findChild(ctx.request, "Collections") : undefined;
        const collectionEls = collections ? findChildren(collections, "Collection") : [];
        if (collectionEls.length === 0) {
            return element(WbxmlCodePage.AirSync, "Sync", [textElement(WbxmlCodePage.AirSync, "Status", "3")]);
        }
        if (collectionEls.length > MAX_SYNC_COLLECTIONS) {
            return element(WbxmlCodePage.AirSync, "Sync", [textElement(WbxmlCodePage.AirSync, "Status", "4")]);
        }

        const requestWindowSize: string | undefined = childText(ctx.request!, "WindowSize");
        const getMailbox = this.mailboxLoader(ctx);
        const collectionElements: WbxmlElement[] = [];
        for (const collectionEl of collectionEls) {
            collectionElements.push(await this.processCollection(ctx, collectionEl, getMailbox, requestWindowSize));
        }

        return element(WbxmlCodePage.AirSync, "Sync", [element(WbxmlCodePage.AirSync, "Collections", collectionElements)]);
    }

    private effectiveWindowSize(requested: string | undefined): number {
        const limit = Math.min(this.windowSize, MAX_WINDOW_SIZE);
        const value = Number(requested);
        return requested !== undefined && Number.isInteger(value) && value > 0 ? Math.min(value, limit) : limit;
    }

    private async processCollection(
        ctx: EasCommandContext,
        collectionEl: WbxmlElement,
        getMailbox: () => Promise<Mailbox>,
        requestWindowSize: string | undefined,
    ): Promise<WbxmlElement> {
        const requestedClass: string | undefined = childText(collectionEl, "Class");
        const folderUid: string | undefined = childText(collectionEl, "CollectionId");
        const clientSyncKey: string | undefined = childText(collectionEl, "SyncKey");

        // A folder the caller can't even read is reported identically to an unrecognized collection - never
        // reveal whether a client-supplied CollectionId belonging to someone else's mailbox actually exists.
        if (!folderUid || !(await this.aclUtils!.hasPermission(ctx.user, folderUid, ACLAction.READ))) {
            return this.collectionResponse(requestedClass, folderUid, "4", clientSyncKey);
        }
        const folder: (Folder & { uid: string }) | undefined = await this.folderRepo!.findOne(folderUid, { ignoreACL: true });
        if (!folder) {
            return this.collectionResponse(requestedClass, folderUid, "4", clientSyncKey);
        }

        const stored: (EasCollectionState & { version: number }) | undefined = (
            await this.collectionStateRepo!.find({ mailboxUid: ctx.mailboxUid, deviceId: ctx.deviceId, folderUid } as any, {
                ignoreACL: true,
                limit: 1,
            })
        )[0];
        const collectionClass: string = requestedClass ?? stored?.collectionClass ?? classForFolderType(folder.type);
        const repo: RepoUtils<any> | undefined = this.repos.get(collectionClass);
        const adapter: EasCollectionSyncAdapter<any> | undefined = this.adapters.get(collectionClass);
        const commandsEl: WbxmlElement | undefined = findChild(collectionEl, "Commands");
        if (!repo || !adapter || (commandsEl?.children.length ?? 0) > MAX_SYNC_COMMANDS_PER_COLLECTION) {
            return this.collectionResponse(collectionClass, folderUid, "4", clientSyncKey);
        }

        const optionsEl: WbxmlElement | undefined = findChild(collectionEl, "Options");
        const requestedFilter: string | undefined = optionsEl ? childText(optionsEl, "FilterType") : undefined;

        if (!clientSyncKey || clientSyncKey === "0") {
            return await this.startCollection(ctx, stored, folderUid, collectionClass, requestedFilter ?? "0");
        }

        let working: CollectionWorkingState;
        let retry: CollectionRound["retry"];
        if (stored && clientSyncKey === stored.syncKey) {
            working = workingStateFromRow(stored);
        } else if (stored?.previous && clientSyncKey === stored.previous.syncKey) {
            working = workingStateFromRound(stored, stored.previous);
            retry = {
                removedIds: new Set(stored.previous.removedIds),
                clientIds: new Map(stored.previous.clientIds.map((entry) => [entry.clientId, entry.serverId])),
            };
        } else {
            return this.collectionResponse(collectionClass, folderUid, "3", undefined);
        }
        if (requestedFilter !== undefined && requestedFilter !== working.filterType) {
            // The window the device's items were selected with no longer matches - restart from SyncKey 0.
            return this.collectionResponse(collectionClass, folderUid, "3", undefined);
        }

        const base: CollectionWorkingState = cloneWorkingState(working);
        const round: CollectionRound = {
            ctx,
            folder,
            collectionClass,
            adapter,
            repo,
            working,
            retry,
            clientIds: new Map(),
            deletesAsMoves: childText(collectionEl, "DeletesAsMoves") !== "0",
            getMailbox,
        };

        const responseEntries: WbxmlElement[] = [];
        if (commandsEl) {
            for (const el of commandsEl.children) {
                const response =
                    el.tag === "Add"
                        ? await this.applyAdd(round, el)
                        : el.tag === "Change"
                          ? await this.applyChange(round, el)
                          : el.tag === "Delete"
                            ? await this.applyDelete(round, el)
                            : undefined;
                if (response) {
                    responseEntries.push(response);
                }
            }
        }

        const { commands, moreAvailable } =
            childText(collectionEl, "GetChanges") === "0"
                ? { commands: [], moreAvailable: false }
                : await enumerateCollection(working, {
                      repo,
                      folderUid,
                      folderMailboxUid: folder.mailboxUid,
                      windowSize: this.effectiveWindowSize(childText(collectionEl, "WindowSize") ?? requestWindowSize),
                      moveScanLimit: this.moveScanLimit,
                      include: filterPredicate(collectionClass, working.filterType),
                  });

        const newKey = formatSyncKey({ generation: working.generation + 1, watermark: working.cursor.date, uid: working.cursor.uid });
        await this.saveState(stored, {
            mailboxUid: ctx.mailboxUid,
            deviceId: ctx.deviceId,
            folderUid,
            collectionClass,
            syncKey: newKey,
            cursorDate: working.cursor.date,
            cursorUid: working.cursor.uid,
            moveCursorDate: working.moveCursor.date,
            moveCursorUid: working.moveCursor.uid,
            serverIds: [...working.serverIds],
            echoes: Object.fromEntries(working.echoes),
            filterType: working.filterType,
            previous: roundRecord(clientSyncKey, base, working, round.clientIds),
        });

        const upserts = commands.filter((c): c is { kind: "Add" | "Change"; item: any } => c.kind !== "Delete");
        const applicationData: WbxmlElement[] =
            upserts.length === 0
                ? []
                : adapter.toApplicationDataBatch
                  ? await adapter.toApplicationDataBatch(upserts.map((c) => c.item))
                  : await Promise.all(upserts.map(async (c) => await adapter.toApplicationData(c.item)));
        const commandElements: WbxmlElement[] = commands.map((c) =>
            c.kind === "Delete"
                ? element(WbxmlCodePage.AirSync, "Delete", [textElement(WbxmlCodePage.AirSync, "ServerId", c.uid)])
                : element(WbxmlCodePage.AirSync, c.kind, [
                      textElement(WbxmlCodePage.AirSync, "ServerId", c.item.uid),
                      applicationData[upserts.indexOf(c)],
                  ]),
        );

        return this.collectionResponse(collectionClass, folderUid, "1", newKey, [
            ...(moreAvailable ? [element(WbxmlCodePage.AirSync, "MoreAvailable", [])] : []),
            ...(commandElements.length > 0 ? [element(WbxmlCodePage.AirSync, "Commands", commandElements)] : []),
            ...(responseEntries.length > 0 ? [element(WbxmlCodePage.AirSync, "Responses", responseEntries)] : []),
        ]);
    }

    /** `SyncKey 0`: (re)starts the collection with an empty item set. Per [MS-ASCMD] the response carries only the
     * new key; the next round reports every item as an `Add`. */
    private async startCollection(
        ctx: EasCommandContext,
        stored: (EasCollectionState & { version: number }) | undefined,
        folderUid: string,
        collectionClass: string,
        filterType: string,
    ): Promise<WbxmlElement> {
        const epoch = new Date(0);
        const newKey = formatSyncKey({ generation: 1, watermark: epoch });
        await this.saveState(stored, {
            mailboxUid: ctx.mailboxUid,
            deviceId: ctx.deviceId,
            folderUid,
            collectionClass,
            syncKey: newKey,
            cursorDate: epoch,
            cursorUid: "",
            moveCursorDate: new Date(Date.now() - MOVE_CURSOR_SLACK_MS),
            moveCursorUid: "",
            serverIds: [],
            echoes: {},
            filterType,
            previous: undefined,
        });
        return this.collectionResponse(collectionClass, folderUid, "1", newKey);
    }

    /** Creates or updates the collection's state row. A lost race (another request for the same collection wrote
     * the row first) is logged rather than failing a request whose side effects already happened - the client's
     * next request then simply gets Status 3 and re-syncs. */
    private async saveState(
        stored: (EasCollectionState & { version: number }) | undefined,
        values: Omit<EasCollectionState, "uid" | "version" | "dateCreated" | "dateModified">,
    ): Promise<void> {
        try {
            if (stored) {
                await this.collectionStateRepo!.update({ ...values, uid: stored.uid, version: stored.version } as any, stored, {
                    ignoreACL: true,
                    skipPush: true,
                });
            } else {
                await this.collectionStateRepo!.create(new this.collectionStateClass(values), { ignoreACL: true, skipPush: true });
            }
        } catch (err: any) {
            this.logger?.warn(`SyncCommand: failed to save sync state for folder ${values.folderUid}: ${err?.message}`);
        }
    }

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

    /** Remembers the `dateModified` the device's own write left on `item`, so the write isn't echoed back. */
    private noteWrite(round: CollectionRound, item: { uid: string; dateModified?: Date | string }): void {
        round.working.serverIds.add(item.uid);
        if (item.dateModified !== undefined) {
            round.working.echoes.set(item.uid, new Date(item.dateModified).toISOString());
        }
    }

    private async applyAdd(round: CollectionRound, el: WbxmlElement): Promise<WbxmlElement> {
        const { ctx, adapter, repo, folder } = round;
        const clientId = childText(el, "ClientId");
        const replayed: string | undefined = clientId ? round.retry?.clientIds.get(clientId) : undefined;
        if (clientId && replayed) {
            // The first attempt already created the item: answer with it, and treat its current state as the device's own
            // write so the replayed round doesn't send it back as a Change.
            const item = await repo.findOne(replayed, { ignoreACL: true });
            if (item) {
                this.noteWrite(round, item);
            }
            round.clientIds.set(clientId, replayed);
            return this.addResponseElement(clientId, replayed, "1");
        }
        const appData = findChild(el, "ApplicationData");
        if (!adapter.fromApplicationData || !appData) {
            return this.addResponseElement(clientId, undefined, "6");
        }
        // [MS-ASCMD] "Add (Sync)": a client can only add *draft* email.
        if (round.collectionClass === "Email" && folder.type !== FolderType.DRAFTS) {
            return this.addResponseElement(clientId, undefined, "6");
        }
        if (!(await this.aclUtils!.hasPermission(ctx.user, folder.uid, ACLAction.CREATE))) {
            return this.addResponseElement(clientId, undefined, "6");
        }
        try {
            const mailbox = await round.getMailbox();
            const defaults = adapter.newEntityDefaults ? adapter.newEntityDefaults(mailbox) : {};
            const partial = await adapter.fromApplicationData(appData, undefined, mailbox);
            const created = await repo.create(
                { ...defaults, ...partial, mailboxUid: folder.mailboxUid, folderUid: folder.uid } as any,
                { ignoreACL: true },
            );
            this.noteWrite(round, created);
            if (clientId) {
                round.clientIds.set(clientId, created.uid);
            }
            return this.addResponseElement(clientId, created.uid, "1");
        } catch {
            // Status 6: "the client has sent a malformed or invalid item".
            return this.addResponseElement(clientId, undefined, "6");
        }
    }

    private async applyChange(round: CollectionRound, el: WbxmlElement): Promise<WbxmlElement | undefined> {
        const { ctx, adapter, repo, folder } = round;
        const serverId = childText(el, "ServerId");
        if (!serverId) {
            return undefined;
        }
        if (!adapter.fromApplicationData) {
            return this.statusResponseElement("Change", serverId, "6");
        }
        const existing = await repo.findOne(serverId, { ignoreACL: true });
        // An item outside this (READ-checked) collection is reported identically to "doesn't exist".
        if (!existing || existing.folderUid !== folder.uid) {
            return this.statusResponseElement("Change", serverId, "8");
        }
        if (!(await this.aclUtils!.hasPermission(ctx.user, folder.uid, ACLAction.UPDATE))) {
            return this.statusResponseElement("Change", serverId, "6");
        }
        const appData = findChild(el, "ApplicationData");
        if (!appData) {
            return this.statusResponseElement("Change", serverId, "6");
        }
        try {
            const partial = await adapter.fromApplicationData(appData, existing, await round.getMailbox());
            const updated = await repo.update({ uid: existing.uid, version: existing.version, ...partial }, existing, { ignoreACL: true });
            this.noteWrite(round, updated);
            return undefined;
        } catch (err: any) {
            if (err instanceof ApiError && err.code === ApiErrors.INVALID_OBJECT_VERSION) {
                return this.statusResponseElement("Change", serverId, "7");
            }
            return this.statusResponseElement("Change", serverId, "6");
        }
    }

    private async applyDelete(round: CollectionRound, el: WbxmlElement): Promise<WbxmlElement | undefined> {
        const { ctx, repo, folder } = round;
        const serverId = childText(el, "ServerId");
        if (!serverId) {
            return undefined;
        }
        const existing = await repo.findOne(serverId, { ignoreACL: true });
        if (!existing || existing.folderUid !== folder.uid) {
            // The retried round already deleted (or moved) this item - the device's retry is already satisfied.
            if (round.retry?.removedIds.has(serverId)) {
                round.working.serverIds.delete(serverId);
                return undefined;
            }
            return this.statusResponseElement("Delete", serverId, "8");
        }
        if (!(await this.aclUtils!.hasPermission(ctx.user, folder.uid, ACLAction.DELETE))) {
            return this.statusResponseElement("Delete", serverId, "6");
        }
        try {
            if (round.collectionClass === "Email" && round.deletesAsMoves && folder.type !== FolderType.DELETED_ITEMS) {
                const deletedItems: Folder & { uid: string } = await findOrCreateWellKnownFolder(
                    this.folderRepo!,
                    this.folderClass,
                    folder.mailboxUid,
                    FolderType.DELETED_ITEMS,
                    ctx.user,
                );
                await repo.update({ uid: existing.uid, version: existing.version, folderUid: deletedItems.uid }, existing, {
                    ignoreACL: true,
                    user: ctx.user,
                });
            } else {
                await repo.delete(existing.uid, { ignoreACL: true });
            }
            round.working.serverIds.delete(serverId);
            round.working.echoes.delete(serverId);
            return undefined;
        } catch {
            return this.statusResponseElement("Delete", serverId, "6");
        }
    }

    /** Builds one `<Collection>` response element. */
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
