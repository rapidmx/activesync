///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
// The plugin contract: a server host registers every export of `./mongo`/`./sql` and mounts, connects or starts
// it, so each entry point must export only ready routes, models and jobs, and package.json must carry a valid
// manifest.
import "reflect-metadata";
import fs from "fs";
import { BackgroundService } from "@rapidrest/service-core";
import { parsePluginManifest } from "@rapidmx/restapi";
import * as MongoEntry from "../src/mongo.js";
import * as SqlEntry from "../src/sql.js";

function describeExport(clazz: any): string {
    if (Reflect.getMetadata("rrst:routePaths", clazz.prototype)) {
        return `route ${Reflect.getMetadata("rrst:routePaths", clazz.prototype).join(",")}`;
    }
    if (Reflect.getMetadata("rrst:datasource", clazz)) {
        return `model ${Reflect.getMetadata("rrst:datasource", clazz)}`;
    }
    if (clazz.prototype instanceof BackgroundService) {
        return "job";
    }
    return "other";
}

describe("plugin entry points", () => {
    it.each([
        ["mongo", MongoEntry, "Mongo", "mongo"],
        ["sql", SqlEntry, "SQL", "sql"],
    ])("./%s exports only mounted routes, its models and concrete jobs", (_name, entry, suffix, datastore) => {
        expect(Object.fromEntries(Object.entries(entry).map(([name, clazz]) => [name, describeExport(clazz)]))).toEqual({
            [`EasRoute${suffix}`]: "route /Microsoft-Server-ActiveSync",
            [`DeviceSyncStateRoute${suffix}`]: "route /api/mail/devices",
            [`DeviceSyncState${suffix}`]: `model ${datastore}`,
            [`EasCollectionState${suffix}`]: `model ${datastore}`,
            [`EasDeviceStateCleanupJob${suffix}`]: "job",
        });
    });

    it("declares a valid plugin manifest", () => {
        const pkg = JSON.parse(fs.readFileSync(new URL("../package.json", import.meta.url), "utf8"));
        const manifest = parsePluginManifest(pkg);
        expect(typeof manifest).toBe("object");
        expect(manifest).toEqual(expect.objectContaining({ displayName: "Exchange ActiveSync" }));
        // DeviceSyncState is `@MailboxScopedData`, so the host must know this plugin stores per-mailbox data.
        expect(pkg.rapidmx.plugin.mailboxScopedData).toBe(true);
    });
});
