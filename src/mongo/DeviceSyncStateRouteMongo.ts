///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import { DeviceSyncStateMongo } from "@rapidmx/restapi/mongo";
import { BaseDeviceSyncStateRoute } from "../BaseDeviceSyncStateRoute.js";

/**
 * @author Jean-Philippe Steinmetz
 */
export class DeviceSyncStateRouteMongo extends BaseDeviceSyncStateRoute<DeviceSyncStateMongo> {
    protected deviceSyncStateClass: any = DeviceSyncStateMongo;
}
