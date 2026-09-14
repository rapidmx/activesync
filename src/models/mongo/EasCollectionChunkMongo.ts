///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import { BaseMongoEntity, DocDecorators, ModelDecorators, PersistenceDecorators } from "@rapidrest/service-core";
import { MailboxScopedData } from "@rapidmx/restapi";
import type { EasCollectionChunk } from "../EasCollectionChunk.js";
const { Description } = DocDecorators;
const { DataStore, Protect } = ModelDecorators;
const { Column, Entity, Index } = PersistenceDecorators;

/**
 * Implementation of the `EasCollectionChunk` interface for storage in a MongoDB database. If SQL is desired,
 * please use `models.sql.EasCollectionChunkSQL` instead.
 *
 * @author Jean-Philippe Steinmetz
 */
@DataStore("mongo")
@Entity()
@MailboxScopedData()
@Description("One slice of the items a device holds for an EAS `Sync` collection.")
@Index("eascollectionchunk_mailbox_device_folder_index", ["mailboxUid", "deviceId", "folderUid", "chunkIndex"], { unique: true })
@Protect(
    {
        uid: "EasCollectionChunk",
        records: [
            { userOrRoleId: "anonymous", actions: [] },
            { userOrRoleId: ".*", actions: [] },
        ],
    },
    false,
)
export class EasCollectionChunkMongo extends BaseMongoEntity implements EasCollectionChunk {
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
    @Description("Position of the chunk within the collection.")
    public chunkIndex: number = 0;

    @Column()
    @Description("The `ServerId`s this chunk holds.")
    public ids: string[] = [];

    constructor(other?: Partial<EasCollectionChunkMongo>) {
        super(other);

        if (other) {
            this.mailboxUid = other.mailboxUid !== undefined ? other.mailboxUid : this.mailboxUid;
            this.deviceId = other.deviceId !== undefined ? other.deviceId : this.deviceId;
            this.folderUid = other.folderUid !== undefined ? other.folderUid : this.folderUid;
            this.chunkIndex = other.chunkIndex !== undefined ? other.chunkIndex : this.chunkIndex;
            this.ids = other.ids !== undefined ? other.ids : this.ids;
        }
    }
}
