///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import "reflect-metadata";
import { isMailboxScopedData } from "@rapidmx/restapi";
import { DeviceSyncStateMongo } from "../../src/models/mongo/DeviceSyncStateMongo.js";
import { DeviceSyncStateSQL } from "../../src/models/sql/DeviceSyncStateSQL.js";

describe("DeviceSyncStateMongo", () => {
    it("is purged with the rest of an erased mailbox's data", () => {
        expect(isMailboxScopedData(DeviceSyncStateMongo)).toBe(true);
    });

    it("DeviceSyncStateMongo falls back to class defaults when constructed with no data.", () => {
        const obj = new DeviceSyncStateMongo();

        expect(obj.mailboxUid).toBe("");
        expect(obj.deviceId).toBe("");
        expect(obj.deviceType).toBe("");
        expect(obj.policyKey).toBeUndefined();
        expect(obj.folderSyncKeys).toEqual({});
        expect(obj.folderCollectionClasses).toEqual({});
        expect(obj.lastSyncAt).toBeUndefined();
        expect(obj.provisioned).toBe(false);
        expect(obj.remoteWipeRequested).toBeUndefined();
        expect(obj.remoteWipeAccountOnly).toBeUndefined();
        expect(obj.remoteWipeAcknowledgedAt).toBeUndefined();
    });

    it("DeviceSyncStateMongo applies provided overrides when constructed with data.", () => {
        const lastSyncAt = new Date("2026-01-20T00:00:00Z");
        const remoteWipeAcknowledgedAt = new Date("2026-01-21T00:00:00Z");
        const obj = new DeviceSyncStateMongo({
            mailboxUid: "mailbox-1",
            deviceId: "device-1",
            deviceType: "iPhone",
            policyKey: "policy-1",
            folderSyncKeys: { "folder-1": "synckey-1" },
            folderCollectionClasses: { "folder-1": "Email" },
            lastSyncAt,
            provisioned: true,
            remoteWipeRequested: true,
            remoteWipeAccountOnly: true,
            remoteWipeAcknowledgedAt,
        });

        expect(obj.mailboxUid).toBe("mailbox-1");
        expect(obj.deviceId).toBe("device-1");
        expect(obj.deviceType).toBe("iPhone");
        expect(obj.policyKey).toBe("policy-1");
        expect(obj.folderSyncKeys).toEqual({ "folder-1": "synckey-1" });
        expect(obj.folderCollectionClasses).toEqual({ "folder-1": "Email" });
        expect(obj.lastSyncAt).toBe(lastSyncAt);
        expect(obj.provisioned).toBe(true);
        expect(obj.remoteWipeRequested).toBe(true);
        expect(obj.remoteWipeAccountOnly).toBe(true);
        expect(obj.remoteWipeAcknowledgedAt).toBe(remoteWipeAcknowledgedAt);
    });

    it("DeviceSyncStateMongo preserves class defaults for fields omitted from a partial override object.", () => {
        const obj = new DeviceSyncStateMongo({});

        expect(obj.mailboxUid).toBe("");
        expect(obj.deviceId).toBe("");
        expect(obj.deviceType).toBe("");
        expect(obj.policyKey).toBeUndefined();
        expect(obj.folderSyncKeys).toEqual({});
        expect(obj.folderCollectionClasses).toEqual({});
        expect(obj.lastSyncAt).toBeUndefined();
        expect(obj.provisioned).toBe(false);
        expect(obj.remoteWipeRequested).toBeUndefined();
        expect(obj.remoteWipeAccountOnly).toBeUndefined();
        expect(obj.remoteWipeAcknowledgedAt).toBeUndefined();
    });
});

describe("DeviceSyncStateSQL", () => {
    it("is purged with the rest of an erased mailbox's data", () => {
        expect(isMailboxScopedData(DeviceSyncStateSQL)).toBe(true);
    });

    it("DeviceSyncStateSQL falls back to class defaults when constructed with no data.", () => {
        const obj = new DeviceSyncStateSQL();

        expect(obj.mailboxUid).toBe("");
        expect(obj.deviceId).toBe("");
        expect(obj.deviceType).toBe("");
        expect(obj.policyKey).toBeUndefined();
        expect(obj.folderSyncKeys).toEqual({});
        expect(obj.folderCollectionClasses).toEqual({});
        expect(obj.lastSyncAt).toBeUndefined();
        expect(obj.provisioned).toBe(false);
        expect(obj.remoteWipeRequested).toBeUndefined();
        expect(obj.remoteWipeAccountOnly).toBeUndefined();
        expect(obj.remoteWipeAcknowledgedAt).toBeUndefined();
    });

    it("DeviceSyncStateSQL applies provided overrides when constructed with data.", () => {
        const lastSyncAt = new Date("2026-01-20T00:00:00Z");
        const remoteWipeAcknowledgedAt = new Date("2026-01-21T00:00:00Z");
        const obj = new DeviceSyncStateSQL({
            mailboxUid: "mailbox-1",
            deviceId: "device-1",
            deviceType: "iPhone",
            policyKey: "policy-1",
            folderSyncKeys: { "folder-1": "synckey-1" },
            folderCollectionClasses: { "folder-1": "Email" },
            lastSyncAt,
            provisioned: true,
            remoteWipeRequested: true,
            remoteWipeAccountOnly: true,
            remoteWipeAcknowledgedAt,
        });

        expect(obj.mailboxUid).toBe("mailbox-1");
        expect(obj.deviceId).toBe("device-1");
        expect(obj.deviceType).toBe("iPhone");
        expect(obj.policyKey).toBe("policy-1");
        expect(obj.folderSyncKeys).toEqual({ "folder-1": "synckey-1" });
        expect(obj.folderCollectionClasses).toEqual({ "folder-1": "Email" });
        expect(obj.lastSyncAt).toBe(lastSyncAt);
        expect(obj.provisioned).toBe(true);
        expect(obj.remoteWipeRequested).toBe(true);
        expect(obj.remoteWipeAccountOnly).toBe(true);
        expect(obj.remoteWipeAcknowledgedAt).toBe(remoteWipeAcknowledgedAt);
    });

    it("DeviceSyncStateSQL preserves class defaults for fields omitted from a partial override object.", () => {
        const obj = new DeviceSyncStateSQL({});

        expect(obj.mailboxUid).toBe("");
        expect(obj.deviceId).toBe("");
        expect(obj.deviceType).toBe("");
        expect(obj.policyKey).toBeUndefined();
        expect(obj.folderSyncKeys).toEqual({});
        expect(obj.folderCollectionClasses).toEqual({});
        expect(obj.lastSyncAt).toBeUndefined();
        expect(obj.provisioned).toBe(false);
        expect(obj.remoteWipeRequested).toBeUndefined();
        expect(obj.remoteWipeAccountOnly).toBeUndefined();
        expect(obj.remoteWipeAcknowledgedAt).toBeUndefined();
    });
});
