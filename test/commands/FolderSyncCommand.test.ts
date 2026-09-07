///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
// Isolated unit test for FolderSyncCommand's defensive `!this.folderRepo` guard clause only - DI (via
// BaseEasRoute's own @Init) always populates folderRepo before a real request can reach handle(), so this
// mirrors the same rationale test/routes/BaseEasRoute.test.ts already uses for its own guard clauses. Every
// other FolderSyncCommand behavior (initial sync, Add/Update/Delete detection, invalid SyncKey handling) is
// exercised via real HTTP+DB requests in test/routes/{mongo,sql}/EasRoute.test.ts.
import config from "../config.js";
import { ObjectFactory } from "@rapidrest/service-core";
import { Logger } from "@rapidrest/core";
import { FolderSyncCommandMongo } from "../../src/commands/mongo/FolderSyncCommandMongo.js";
import type { EasCommandContext } from "../../src/EasCommandHandler.js";

describe("FolderSyncCommand Tests (guard clause only)", () => {
    it("handle() throws INTERNAL_ERROR when folderRepo is not set.", async () => {
        const objectFactory = new ObjectFactory(config, Logger());
        // `initialize: false` skips `@Init`, leaving folderRepo genuinely undefined - exactly what this guard
        // clause exists to catch.
        const command = objectFactory.newInstance<FolderSyncCommandMongo>(FolderSyncCommandMongo, { initialize: false });

        await expect(command.handle({})).rejects.toThrow(/internal error/i);
    });
});
