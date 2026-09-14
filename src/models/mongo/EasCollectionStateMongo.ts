///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import { BaseMongoEntity, DocDecorators, ModelDecorators, PersistenceDecorators } from "@rapidrest/service-core";
import { ObjectDecorators } from "@rapidrest/core";
import { MailboxScopedData } from "@rapidmx/restapi";
import type { EasCollectionRound, EasCollectionState } from "../EasCollectionState.js";
const { Description } = DocDecorators;
const { DataStore, Protect } = ModelDecorators;
const { Nullable } = ObjectDecorators;
const { Column, Entity, Index } = PersistenceDecorators;

/**
 * Implementation of the `EasCollectionState` interface for storage in a MongoDB database. If SQL is desired,
 * please use `models.sql.EasCollectionStateSQL` instead.
 *
 * @author Jean-Philippe Steinmetz
 */
@DataStore("mongo")
@Entity()
@MailboxScopedData()
@Description("Per-device state of one EAS `Sync` collection.")
@Index("eascollectionstate_mailbox_device_folder", ["mailboxUid", "deviceId", "folderUid"], { unique: true })
@Protect(
    {
        uid: "EasCollectionState",
        records: [
            { userOrRoleId: "anonymous", actions: [] },
            { userOrRoleId: ".*", actions: [] },
        ],
    },
    false,
)
export class EasCollectionStateMongo extends BaseMongoEntity implements EasCollectionState {
    @Column()
    @Description("The unique identifier of the `Mailbox` the device is synced against.")
    public mailboxUid: string = "";

    @Column()
    @Description("The unique identifier of the paired device.")
    public deviceId: string = "";

    @Column()
    @Description("The unique identifier of the synced `Folder`.")
    public folderUid: string = "";

    @Column()
    @Description("The EAS `Class` of the collection.")
    public collectionClass: string = "";

    @Column()
    @Description("The `SyncKey` most recently issued for this collection.")
    public syncKey: string = "";

    @Column()
    @Description("The `dateModified` position in the folder's change stream.")
    public cursorDate: Date = new Date(0);

    @Column()
    @Description("The `uid` tie-breaker of the folder change stream position.")
    public cursorUid: string = "";

    @Column()
    @Description("The `dateModified` position in the stream of items outside the folder.")
    public moveCursorDate: Date = new Date(0);

    @Column()
    @Description("The `uid` tie-breaker of the outside-the-folder stream position.")
    public moveCursorUid: string = "";

    @Column()
    @Description("The `ServerId`s the device currently holds for this collection.")
    public serverIds: string[] = [];

    @Column()
    @Description("Item uid to the `dateModified` left by the device's own write.")
    public echoes: Record<string, string> = {};

    @Column()
    @Description("The `FilterType` the collection was synced with.")
    @Nullable
    public filterType?: string;

    @Column()
    @Description("The state before the most recent round, for a retried `SyncKey`.")
    @Nullable
    public previous?: EasCollectionRound;

    constructor(other?: Partial<EasCollectionStateMongo>) {
        super(other);

        if (other) {
            this.mailboxUid = other.mailboxUid !== undefined ? other.mailboxUid : this.mailboxUid;
            this.deviceId = other.deviceId !== undefined ? other.deviceId : this.deviceId;
            this.folderUid = other.folderUid !== undefined ? other.folderUid : this.folderUid;
            this.collectionClass = other.collectionClass !== undefined ? other.collectionClass : this.collectionClass;
            this.syncKey = other.syncKey !== undefined ? other.syncKey : this.syncKey;
            this.cursorDate = other.cursorDate !== undefined ? other.cursorDate : this.cursorDate;
            this.cursorUid = other.cursorUid !== undefined ? other.cursorUid : this.cursorUid;
            this.moveCursorDate = other.moveCursorDate !== undefined ? other.moveCursorDate : this.moveCursorDate;
            this.moveCursorUid = other.moveCursorUid !== undefined ? other.moveCursorUid : this.moveCursorUid;
            this.serverIds = other.serverIds !== undefined ? other.serverIds : this.serverIds;
            this.echoes = other.echoes !== undefined ? other.echoes : this.echoes;
            this.filterType = "filterType" in other ? other.filterType : this.filterType;
            this.previous = "previous" in other ? other.previous : this.previous;
        }
    }
}
