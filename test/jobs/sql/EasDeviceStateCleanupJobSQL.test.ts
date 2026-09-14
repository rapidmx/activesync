///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
// Real-DB + real-DI integration test for EasDeviceStateCleanupJobSQL: a real SQLite (better-sqlite3) connection
// and a real `ObjectFactory` construct the job exactly as production wiring would - see
// EasDeviceStateCleanupJobMongo.test.ts's file header for the full rationale (also applies here verbatim). Uses
// `config.sql.ts`, whose `acl` datastore is ALSO SQL-backed (`AccessControlListSQL`, auto-selected by `ACLUtils`
// from the connection's runtime type) - so this file has no MongoDB dependency at all.
import { ACLUtils, AccessControlListSQL, ConnectionManager, ObjectFactory, isSqlDataSource } from "@rapidrest/service-core";
import { Logger } from "@rapidrest/core";
import * as uuid from "uuid";
import { In, Repository } from "typeorm";
import config from "../../config.sql.js";
import { EasDeviceStateCleanupJobSQL } from "../../../src/jobs/sql/EasDeviceStateCleanupJobSQL.js";
import { DeviceSyncStateSQL } from "../../../src/models/sql/DeviceSyncStateSQL.js";
import { EasCollectionStateSQL } from "../../../src/models/sql/EasCollectionStateSQL.js";
import { EasCollectionChunkSQL } from "../../../src/models/sql/EasCollectionChunkSQL.js";

const DEVICE_TTL_DAYS = 90; // matches mail:jobs:eas_device_cleanup:device_ttl_days in test/config.ts
const DAY_MS = 24 * 60 * 60 * 1000;

describe("EasDeviceStateCleanupJobSQL Tests (real DB + DI)", () => {
    const logger = Logger();
    let objectFactory: ObjectFactory;
    let connectionManager: ConnectionManager;
    let job: EasDeviceStateCleanupJobSQL;
    let collectionStateRepo: Repository<EasCollectionStateSQL>;
    let collectionChunkRepo: Repository<EasCollectionChunkSQL>;
    let deviceSyncStateRepo: Repository<DeviceSyncStateSQL>;

    const createDevice = async (data?: Partial<DeviceSyncStateSQL>): Promise<DeviceSyncStateSQL> => {
        const obj = new DeviceSyncStateSQL({
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
        objectFactory = new ObjectFactory(config, logger);
        // Normally registered by `Server`'s own bootstrap - registered explicitly here since this file
        // deliberately bypasses `Server` (see EasDeviceStateCleanupJobMongo.test.ts's header comment).
        objectFactory.register(ACLUtils);

        connectionManager = await objectFactory.newInstance(ConnectionManager, { name: "default" });
        const models = new Map<string, any>();
        // Not auto-discovered here the way `Server`'s `ClassLoader` scan would - a bare TypeORM `DataSource`
        // throws "No metadata found" from `getRepository()` for any entity not explicitly in this map.
        models.set("AccessControlListSQL", AccessControlListSQL);
        models.set("DeviceSyncStateSQL", DeviceSyncStateSQL);
        models.set("EasCollectionStateSQL", EasCollectionStateSQL);
        models.set("EasCollectionChunkSQL", EasCollectionChunkSQL);
        await connectionManager.connect(config.get("datastores"), models);

        const conn: any = connectionManager.connections.get("sql");
        if (!isSqlDataSource(conn)) {
            throw new Error("Could not find sql connection");
        }
        deviceSyncStateRepo = conn.getRepository(DeviceSyncStateSQL);
        collectionStateRepo = conn.getRepository(EasCollectionStateSQL);
        collectionChunkRepo = conn.getRepository(EasCollectionChunkSQL);

        // Constructed once via real ObjectFactory DI: `@Init` builds its one real `RepoUtils` against the live
        // connection above.
        job = await objectFactory.newInstance(EasDeviceStateCleanupJobSQL, { name: "default" });
    });

    afterAll(async () => {
        await objectFactory.destroy();
    });

    beforeEach(async () => {
        await deviceSyncStateRepo.clear();
        await collectionStateRepo.clear();
        await collectionChunkRepo.clear();
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

        const found = await deviceSyncStateRepo.findOne({ where: { uid: stale.uid } });
        expect(found).toBeNull();
    });

    it("Keeps a device that synced recently, within the configured TTL.", async () => {
        const recent = await createDevice({ lastSyncAt: new Date(Date.now() - (DEVICE_TTL_DAYS - 5) * DAY_MS) });

        await job.run();

        const found = await deviceSyncStateRepo.findOne({ where: { uid: recent.uid } });
        expect(found).not.toBeNull();
    });

    it("Never purges a stale or never-synced device with a pending remote wipe, but still purges wiped/unset ones.", async () => {
        const staleDate = new Date(Date.now() - (DEVICE_TTL_DAYS + 5) * DAY_MS);
        const pendingStale = await createDevice({ lastSyncAt: staleDate, remoteWipeRequested: true });
        const pendingNeverSynced = await createDevice({ lastSyncAt: undefined, remoteWipeRequested: true });
        const acknowledged = await createDevice({ lastSyncAt: staleDate, remoteWipeRequested: false });
        const unset = await createDevice({ lastSyncAt: staleDate, remoteWipeRequested: undefined });
        const unsetNeverSynced = await createDevice({ lastSyncAt: undefined, remoteWipeRequested: undefined });
        const blocked = await createDevice({ lastSyncAt: staleDate, remoteWipeRequested: false, blocked: true });
        const unblocked = await createDevice({ lastSyncAt: undefined, blocked: false });

        await job.run();

        // A device blocked after acknowledging a wipe is kept too, or it could pair again as a new device.
        expect(await deviceSyncStateRepo.findOne({ where: { uid: blocked.uid } })).not.toBeNull();
        expect(await deviceSyncStateRepo.findOne({ where: { uid: unblocked.uid } })).toBeNull();

        expect(await deviceSyncStateRepo.findOne({ where: { uid: pendingStale.uid } })).not.toBeNull();
        expect(await deviceSyncStateRepo.findOne({ where: { uid: pendingNeverSynced.uid } })).not.toBeNull();
        expect(await deviceSyncStateRepo.findOne({ where: { uid: acknowledged.uid } })).toBeNull();
        expect(await deviceSyncStateRepo.findOne({ where: { uid: unset.uid } })).toBeNull();
        expect(await deviceSyncStateRepo.findOne({ where: { uid: unsetNeverSynced.uid } })).toBeNull();
    });

    it("Purges a device that has never successfully synced, regardless of age.", async () => {
        const neverSynced = await createDevice({ lastSyncAt: undefined });

        await job.run();

        const found = await deviceSyncStateRepo.findOne({ where: { uid: neverSynced.uid } });
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

        const remaining = await deviceSyncStateRepo.find({ where: { uid: In(devices.map((d) => d.uid)) } });
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

        const badFound = await deviceSyncStateRepo.findOne({ where: { uid: badDevice.uid } });
        const goodFound = await deviceSyncStateRepo.findOne({ where: { uid: goodDevice.uid } });
        expect(badFound).not.toBeNull();
        expect(goodFound).toBeNull();
    });
    it("Purges a forgotten device's per-collection Sync state (in batches), leaving other devices' state alone.", async () => {
        (job as any).batchSize = 2;
        const stale = await createDevice({ lastSyncAt: new Date(Date.now() - (DEVICE_TTL_DAYS + 5) * DAY_MS) });
        const recent = await createDevice({ lastSyncAt: new Date() });
        const collection = (device: DeviceSyncStateSQL, folderUid: string) =>
            collectionStateRepo.save(
                new EasCollectionStateSQL({ mailboxUid: device.mailboxUid, deviceId: device.deviceId, folderUid, collectionClass: "Email", syncKey: "1:x" }) as any,
            );
        for (const folderUid of ["f1", "f2", "f3"]) {
            await collection(stale, folderUid);
        }
        await collection(recent, "f1");
        await collectionStateRepo.save(
            new EasCollectionStateSQL({ mailboxUid: stale.mailboxUid, deviceId: stale.deviceId, folderUid: "f4", collectionClass: "Email", syncKey: "1:x", chunked: true }) as any,
        );
        await collectionChunkRepo.save(new EasCollectionChunkSQL({ mailboxUid: stale.mailboxUid, deviceId: stale.deviceId, folderUid: "f4", chunkIndex: 0, ids: ["a"] }) as any);
        await collectionChunkRepo.save(new EasCollectionChunkSQL({ mailboxUid: recent.mailboxUid, deviceId: recent.deviceId, folderUid: "f4", chunkIndex: 0, ids: ["a"] }) as any);

        await job.run();

        expect(await collectionChunkRepo.count({ where: { deviceId: stale.deviceId } })).toBe(0);
        expect(await collectionChunkRepo.count({ where: { deviceId: recent.deviceId } })).toBe(1);
        expect(await collectionStateRepo.count({ where: { deviceId: stale.deviceId } })).toBe(0);
        expect(await collectionStateRepo.count({ where: { deviceId: recent.deviceId } })).toBe(1);
    });

    it("Logs a warning and keeps a device whose collection state couldn't be purged, so the next run retries it.", async () => {
        const stale = await createDevice({ lastSyncAt: new Date(Date.now() - (DEVICE_TTL_DAYS + 5) * DAY_MS) });
        vi.spyOn((job as any).collectionStateRepo, "find").mockRejectedValueOnce(new Error("simulated collection state failure"));

        await expect(job.run()).resolves.toBeUndefined();

        expect(await deviceSyncStateRepo.findOne({ where: { uid: stale.uid } })).not.toBeNull();
    });
});
