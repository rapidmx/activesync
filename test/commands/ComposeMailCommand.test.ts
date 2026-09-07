///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
// Isolated unit tests for ComposeMailCommand's defensive guard clauses only - DI (via BaseEasRoute's own
// @Init) always populates every injected dependency before a real request can reach handle(), same rationale
// test/routes/BaseEasRoute.test.ts and test/eas/commands/FolderSyncCommand.test.ts already use for their own
// guard clauses. Every real SendMail/SmartForward/SmartReply behavior (relay, Sent Items persistence, Source
// resolution/threading, original-message flag flips, spam/transport rejection) is exercised via real HTTP+DB
// requests in test/routes/{mongo,sql}/EasRoute.test.ts.
import config from "../config.js";
import { ObjectFactory } from "@rapidrest/service-core";
import { Logger } from "@rapidrest/core";
import { SendMailCommandMongo } from "../../src/commands/mongo/SendMailCommandMongo.js";
import type { EasCommandContext } from "../../src/EasCommandHandler.js";

describe("ComposeMailCommand Tests (guard clauses only)", () => {
    const objectFactory = new ObjectFactory(config, Logger());

    it("handle() throws INTERNAL_ERROR when a required dependency is not set.", async () => {
        // `initialize: false` skips `@Init` (and `@Inject`), leaving every dependency genuinely undefined -
        // exactly what this guard clause exists to catch.
        const command = objectFactory.newInstance<SendMailCommandMongo>(SendMailCommandMongo, { initialize: false });

        await expect(command.handle({})).rejects.toThrow(/internal error/i);
    });

    it("handle() throws INVALID_REQUEST when the request body is absent.", async () => {
        const command = objectFactory.newInstance<SendMailCommandMongo>(SendMailCommandMongo, { initialize: false });
        // Poking the private fields directly (TypeScript `private`/`protected` is compile-time only) isolates
        // this guard from the one above, which would otherwise fire first.
        (command as any).folderRepo = {};
        (command as any).messageRepo = {};
        (command as any).blobStore = {};
        (command as any).mailTransport = {};
        (command as any).scanPipeline = {};

        await expect(command.handle({ request: undefined })).rejects.toThrow(/invalid/i);
    });
});
