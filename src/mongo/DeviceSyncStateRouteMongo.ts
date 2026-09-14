///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import { RouteDecorators } from "@rapidrest/service-core";
import { DeviceSyncStateMongo } from "../models/mongo/DeviceSyncStateMongo.js";
import { BaseDeviceSyncStateRoute } from "../BaseDeviceSyncStateRoute.js";
const { ApiRoute } = RouteDecorators;

/**
 * @author Jean-Philippe Steinmetz
 */
@ApiRoute("mail/devices")
export class DeviceSyncStateRouteMongo extends BaseDeviceSyncStateRoute<DeviceSyncStateMongo> {
    protected deviceSyncStateClass: any = DeviceSyncStateMongo;
}
