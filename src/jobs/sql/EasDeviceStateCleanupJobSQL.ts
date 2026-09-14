///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import { Raw } from "typeorm";
import { EasDeviceStateCleanupJob } from "../EasDeviceStateCleanupJob.js";
import { DeviceSyncStateSQL } from "../../models/sql/DeviceSyncStateSQL.js";
import { EasCollectionStateSQL } from "../../models/sql/EasCollectionStateSQL.js";

export class EasDeviceStateCleanupJobSQL extends EasDeviceStateCleanupJob<DeviceSyncStateSQL> {
    protected deviceSyncStateClass: any = DeviceSyncStateSQL;
    protected collectionStateClass: any = EasCollectionStateSQL;

    /** SQL's `column != true` is never true for a `NULL` column, so "no pending wipe" needs an explicit `IS NULL`. */
    protected noPendingWipeQueryValue(): any {
        return Raw((alias) => `(${alias} IS NULL OR ${alias} = :noPendingWipe)`, { noPendingWipe: false });
    }
}
