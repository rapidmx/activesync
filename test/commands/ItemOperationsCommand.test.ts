///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
// Isolated unit test for ItemOperationsCommand's defensive dependency guard clause only - DI (via
// BaseEasRoute's own @Init) always populates every injected dependency before a real request can reach
// handle(), same rationale test/eas/commands/ComposeMailCommand.test.ts already uses for its own guard
// clause. Every real Fetch behavior (message body, attachment content, 404/403/400 branches) is exercised via
// real HTTP+DB requests in test/routes/{mongo,sql}/EasRoute.test.ts.
import config from "../config.js";
import { ObjectFactory } from "@rapidrest/service-core";
import { Logger } from "@rapidrest/core";
import { ItemOperationsCommandMongo } from "../../src/commands/mongo/ItemOperationsCommandMongo.js";
import type { EasCommandContext } from "../../src/EasCommandHandler.js";

describe("ItemOperationsCommand Tests (guard clause only)", () => {
    it("handle() throws INTERNAL_ERROR when a required dependency is not set.", async () => {
        const objectFactory = new ObjectFactory(config, Logger());
        const command = objectFactory.newInstance<ItemOperationsCommandMongo>(ItemOperationsCommandMongo, { initialize: false });

        await expect(command.handle({})).rejects.toThrow(/internal error/i);
    });
});
