///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
/**
 * This plugin's `./sql` entry point: exactly the classes a server host loads for a SQL deployment - the
 * mounted routes, the device-state model and its cleanup job. Anything else exported here would be registered
 * by the host too (and an abstract `BackgroundService` would even be started), so the command and adapter
 * classes these routes use stay internal.
 */
export { EasRouteSQL } from "./sql/EasRouteSQL.js";
export { DeviceSyncStateRouteSQL } from "./sql/DeviceSyncStateRouteSQL.js";
export { DeviceSyncStateSQL } from "./models/sql/DeviceSyncStateSQL.js";
export { EasCollectionStateSQL } from "./models/sql/EasCollectionStateSQL.js";
export { EasDeviceStateCleanupJobSQL } from "./jobs/sql/EasDeviceStateCleanupJobSQL.js";
