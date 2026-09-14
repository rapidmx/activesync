///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
// Real-DB + real-DI integration test for EasDeviceStateCleanupJobMongo: a real in-memory MongoDB connection and
// a real `ObjectFactory` construct the job exactly as production wiring would - its own `@Init` builds a real
// `RepoUtils` against the live connection. No repo is hand-mocked. See
// ../../jobs/mongo/ScanQueueJobMongo.test.ts's file header for the full rationale behind bypassing
// `Server`/`ClassLoader`.
import { MongoMemoryServer } from "mongodb-memory-server";
import { ACLUtils, ConnectionManager, MongoConnection, MongoRepository, ObjectFactory } from "@rapidrest/service-core";
import { Logger } from "@rapidrest/core";
import * as uuid from "uuid";
import config from "../../config.js";
import { EasDeviceStateCleanupJobMongo } from "../../../src/jobs/mongo/EasDeviceStateCleanupJobMongo.js";
import { DeviceSyncStateMongo } from "../../../src/models/mongo/DeviceSyncStateMongo.js";
import { EasCollectionStateMongo } from "../../../src/models/mongo/EasCollectionStateMongo.js";
import { EasCollectionChunkMongo } from "../../../src/models/mongo/EasCollectionChunkMongo.js";

const mongod: MongoMemoryServer = new MongoMemoryServer({
    instance: { port: 9999, dbName: "rrst-test" },
});

const DEVICE_TTL_DAYS = 90; // matches mail:jobs:eas_device_cleanup:device_ttl_days in test/config.ts
const DAY_MS = 24 * 60 * 60 * 1000;

describe("EasDeviceStateCleanupJobMongo Tests (real DB + DI)", () => {
    const logger = Logger();
    let objectFactory: ObjectFactory;
    let connectionManager: ConnectionManager;
    let job: EasDeviceStateCleanupJobMongo;
    let collectionStateRepo: MongoRepository<EasCollectionStateMongo>;
    let collectionChunkRepo: MongoRepository<EasCollectionChunkMongo>;
    let deviceSyncStateRepo: MongoRepository<DeviceSyncStateMongo>;

    const createDevice = async (data?: Partial<DeviceSyncStateMongo>): Promise<DeviceSyncStateMongo> => {
        const obj = new DeviceSyncStateMongo({
            mailboxUid: uuid.v4(),
            deviceId: uuid.v4(),
            deviceType: "iPhone",
            folderSyncKeys: {},
            provisioned: true,
            ...data,
        });
        return await deviceSyncStateRepo.save(obj);
    };

    beforeAll(async () => {
        await mongod.start();
        objectFactory = new ObjectFactory(config, logger);
        // Normally registered by `Server`'s own bootstrap - registered explicitly here since this file
        // deliberately bypasses `Server` (see ScanQueueJobMongo.test.ts's header comment).
        objectFactory.register(ACLUtils);

        connectionManager = await objectFactory.newInstance(ConnectionManager, { name: "default" });
        const models = new Map<string, any>();
        models.set("DeviceSyncStateMongo", DeviceSyncStateMongo);
        models.set("EasCollectionStateMongo", EasCollectionStateMongo);
        models.set("EasCollectionChunkMongo", EasCollectionChunkMongo);
        await connectionManager.connect(config.get("datastores"), models);

        const conn: any = connectionManager.connections.get("mongo");
        if (!(conn instanceof MongoConnection)) {
            throw new Error("Could not find mongo connection");
        }
        deviceSyncStateRepo = conn.getMongoRepository("DeviceSyncStateMongo");
        collectionStateRepo = conn.getMongoRepository("EasCollectionStateMongo");
        collectionChunkRepo = conn.getMongoRepository("EasCollectionChunkMongo");

        // Constructed once via real ObjectFactory DI: `@Init` builds its one real `RepoUtils` against the live
        // connection above.
        job = await objectFactory.newInstance(EasDeviceStateCleanupJobMongo, { name: "default" });
    });

    afterAll(async () => {
        await objectFactory.destroy();
        await mongod.stop();
    });

    beforeEach(async () => {
        try {
            await deviceSyncStateRepo.clear();
        } catch (err: any) {
            if (err.message !== "ns not found") {
                throw err;
            }
        }
        try {
            await collectionStateRepo.clear();
        } catch (err: any) {
            if (err.message !== "ns not found") {
                throw err;
            }
        }
        try {
            await collectionChunkRepo.clear();
        } catch (err: any) {
            if (err.message !== "ns not found") {
                throw err;
            }
        }
        // Restore the job's batch size to the configured default between tests, in case a test overrode it.
        (job as any).batchSize = config.get("mail:jobs:eas_device_cleanup:batch_size") ?? 500;
    });

    afterEach(() => {
        vi.restoreAllMocks();
    });

    it("Exposes the configured cron schedule.", () => {
        expect(job.schedule).toBe(config.get("mail:jobs:eas_device_cleanup:schedule"));
    });

    it("start() and stop() are no-ops beyond init().", async () => {
        await expect(job.start()).resolves.toBeUndefined();
        expect(job.stop()).toBeUndefined();
    });

    it("Does nothing when there are no device sync state rows.", async () => {
        await expect(job.run()).resolves.toBeUndefined();
    });

    it("Does nothing when deviceSyncStateRepo is not yet initialized.", async () => {
        const original = (job as any).deviceSyncStateRepo;
        (job as any).deviceSyncStateRepo = undefined;
        try {
            await expect(job.run()).resolves.toBeUndefined();
        } finally {
            (job as any).deviceSyncStateRepo = original;
        }
    });

    it("Purges a device that hasn't synced in more than the configured TTL.", async () => {
        const stale = await createDevice({ lastSyncAt: new Date(Date.now() - (DEVICE_TTL_DAYS + 5) * DAY_MS) });

        await job.run();

        const found = await deviceSyncStateRepo.findOne({ uid: stale.uid } as any);
        expect(found).toBeNull();
    });

    it("Keeps a device that synced recently, within the configured TTL.", async () => {
        const recent = await createDevice({ lastSyncAt: new Date(Date.now() - (DEVICE_TTL_DAYS - 5) * DAY_MS) });

        await job.run();

        const found = await deviceSyncStateRepo.findOne({ uid: recent.uid } as any);
        expect(found).not.toBeNull();
    });

    it("Never purges a stale or never-synced device with a pending remote wipe, but still purges wiped/unset ones.", async () => {
        const staleDate = new Date(Date.now() - (DEVICE_TTL_DAYS + 5) * DAY_MS);
        const pendingStale = await createDevice({ lastSyncAt: staleDate, remoteWipeRequested: true });
        const pendingNeverSynced = await createDevice({ lastSyncAt: undefined, remoteWipeRequested: true });
        const acknowledged = await createDevice({ lastSyncAt: staleDate, remoteWipeRequested: false });
        const unset = await createDevice({ lastSyncAt: staleDate, remoteWipeRequested: undefined });
        const blocked = await createDevice({ lastSyncAt: staleDate, remoteWipeRequested: false, blocked: true });
        const unblocked = await createDevice({ lastSyncAt: undefined, blocked: false });

        await job.run();

        // A device blocked after acknowledging a wipe is kept too, or it could pair again as a new device.
        expect(await deviceSyncStateRepo.findOne({ uid: blocked.uid } as any)).not.toBeNull();
        expect(await deviceSyncStateRepo.findOne({ uid: unblocked.uid } as any)).toBeNull();

        expect(await deviceSyncStateRepo.findOne({ uid: pendingStale.uid } as any)).not.toBeNull();
        expect(await deviceSyncStateRepo.findOne({ uid: pendingNeverSynced.uid } as any)).not.toBeNull();
        expect(await deviceSyncStateRepo.findOne({ uid: acknowledged.uid } as any)).toBeNull();
        expect(await deviceSyncStateRepo.findOne({ uid: unset.uid } as any)).toBeNull();
    });

    it("Purges a device that has never successfully synced, regardless of age.", async () => {
        const neverSynced = await createDevice({ lastSyncAt: undefined });

        await job.run();

        const found = await deviceSyncStateRepo.findOne({ uid: neverSynced.uid } as any);
        expect(found).toBeNull();
    });

    it("Bounds how many stale rows are purged per run to the configured batch size.", async () => {
        (job as any).batchSize = 2;
        const staleDate = new Date(Date.now() - (DEVICE_TTL_DAYS + 5) * DAY_MS);
        const devices = await Promise.all([
            createDevice({ lastSyncAt: staleDate }),
            createDevice({ lastSyncAt: staleDate }),
            createDevice({ lastSyncAt: staleDate }),
        ]);

        await job.run();

        const remaining = await deviceSyncStateRepo
            .find({ uid: { $in: devices.map((d) => d.uid) } })
            .toArray();
        expect(remaining.length).toBe(1);
    });

    it("Logs a warning and continues purging subsequent rows when one delete throws.", async () => {
        // Real infrastructure has no deterministic, non-destructive way to make a single row's own delete throw
        // (a plain delete against a healthy DB simply succeeds, even for an already-removed row) - this targets
        // a fault at the one seam real infra can't reach: the job's own internal `RepoUtils.delete()` call for
        // the "bad" row, restored immediately after so every other call in this test still goes to the real
        // database.
        const staleDate = new Date(Date.now() - (DEVICE_TTL_DAYS + 5) * DAY_MS);
        const badDevice = await createDevice({ lastSyncAt: staleDate });
        const goodDevice = await createDevice({ lastSyncAt: staleDate });

        const repoUtils = (job as any).deviceSyncStateRepo;
        const originalDelete = repoUtils.delete.bind(repoUtils);
        vi.spyOn(repoUtils, "delete").mockImplementation(async (uid: string, opts: any) => {
            if (uid === badDevice.uid) {
                throw new Error("simulated database failure");
            }
            return originalDelete(uid, opts);
        });

        await expect(job.run()).resolves.toBeUndefined();

        const badFound = await deviceSyncStateRepo.findOne({ uid: badDevice.uid } as any);
        const goodFound = await deviceSyncStateRepo.findOne({ uid: goodDevice.uid } as any);
        expect(badFound).not.toBeNull();
        expect(goodFound).toBeNull();
    });
    it("Purges a forgotten device's per-collection Sync state (in batches), leaving other devices' state alone.", async () => {
        (job as any).batchSize = 2;
        const stale = await createDevice({ lastSyncAt: new Date(Date.now() - (DEVICE_TTL_DAYS + 5) * DAY_MS) });
        const recent = await createDevice({ lastSyncAt: new Date() });
        const collection = (device: DeviceSyncStateMongo, folderUid: string) =>
            collectionStateRepo.save(
                new EasCollectionStateMongo({ mailboxUid: device.mailboxUid, deviceId: device.deviceId, folderUid, collectionClass: "Email", syncKey: "1:x" }),
            );
        for (const folderUid of ["f1", "f2", "f3"]) {
            await collection(stale, folderUid);
        }
        await collection(recent, "f1");
        await collectionStateRepo.save(
            new EasCollectionStateMongo({ mailboxUid: stale.mailboxUid, deviceId: stale.deviceId, folderUid: "f4", collectionClass: "Email", syncKey: "1:x", chunked: true }),
        );
        await collectionChunkRepo.save(new EasCollectionChunkMongo({ mailboxUid: stale.mailboxUid, deviceId: stale.deviceId, folderUid: "f4", chunkIndex: 0, ids: ["a"] }));
        // Orphaned by a failed inline-to-chunked conversion: the row (f1) still says it isn't chunked.
        await collectionChunkRepo.save(new EasCollectionChunkMongo({ mailboxUid: stale.mailboxUid, deviceId: stale.deviceId, folderUid: "f1", chunkIndex: 0, ids: ["b"] }));
        await collectionChunkRepo.save(new EasCollectionChunkMongo({ mailboxUid: recent.mailboxUid, deviceId: recent.deviceId, folderUid: "f4", chunkIndex: 0, ids: ["a"] }));

        await job.run();

        expect((await collectionChunkRepo.find({ deviceId: stale.deviceId }).toArray()).length).toBe(0);
        expect((await collectionChunkRepo.find({ deviceId: recent.deviceId }).toArray()).length).toBe(1);
        expect((await collectionStateRepo.find({ deviceId: stale.deviceId }).toArray()).length).toBe(0);
        expect((await collectionStateRepo.find({ deviceId: recent.deviceId }).toArray()).length).toBe(1);
    });

    it("Logs a warning and keeps a device whose collection state couldn't be purged, so the next run retries it.", async () => {
        const stale = await createDevice({ lastSyncAt: new Date(Date.now() - (DEVICE_TTL_DAYS + 5) * DAY_MS) });
        vi.spyOn((job as any).collectionStateRepo, "find").mockRejectedValueOnce(new Error("simulated collection state failure"));

        await expect(job.run()).resolves.toBeUndefined();

        expect(await deviceSyncStateRepo.findOne({ uid: stale.uid } as any)).not.toBeNull();
    });
});
