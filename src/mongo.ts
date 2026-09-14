///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
/**
 * This plugin's `./mongo` entry point: exactly the classes a server host loads for a Mongo deployment - the
 * mounted routes, the device-state model and its cleanup job. Anything else exported here would be registered
 * by the host too (and an abstract `BackgroundService` would even be started), so the command and adapter
 * classes these routes use stay internal.
 */
export { EasRouteMongo } from "./mongo/EasRouteMongo.js";
export { DeviceSyncStateRouteMongo } from "./mongo/DeviceSyncStateRouteMongo.js";
export { DeviceSyncStateMongo } from "./models/mongo/DeviceSyncStateMongo.js";
export { EasCollectionStateMongo } from "./models/mongo/EasCollectionStateMongo.js";
export { EasCollectionChunkMongo } from "./models/mongo/EasCollectionChunkMongo.js";
export { EasDeviceStateCleanupJobMongo } from "./jobs/mongo/EasDeviceStateCleanupJobMongo.js";
