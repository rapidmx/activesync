///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import { EasDeviceStateCleanupJob } from "../EasDeviceStateCleanupJob.js";
import { DeviceSyncStateMongo } from "../../models/mongo/DeviceSyncStateMongo.js";
import { EasCollectionStateMongo } from "../../models/mongo/EasCollectionStateMongo.js";
import { EasCollectionChunkMongo } from "../../models/mongo/EasCollectionChunkMongo.js";

export class EasDeviceStateCleanupJobMongo extends EasDeviceStateCleanupJob<DeviceSyncStateMongo> {
    protected deviceSyncStateClass: any = DeviceSyncStateMongo;
    protected collectionStateClass: any = EasCollectionStateMongo;
    protected collectionChunkClass: any = EasCollectionChunkMongo;
}
