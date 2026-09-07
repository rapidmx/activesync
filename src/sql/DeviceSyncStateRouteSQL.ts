///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import { DeviceSyncStateSQL } from "@rapidmx/restapi/sql";
import { BaseDeviceSyncStateRoute } from "../BaseDeviceSyncStateRoute.js";

/**
 * @author Jean-Philippe Steinmetz
 */
export class DeviceSyncStateRouteSQL extends BaseDeviceSyncStateRoute<DeviceSyncStateSQL> {
    protected deviceSyncStateClass: any = DeviceSyncStateSQL;
}
