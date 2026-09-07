///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
// Isolated unit test for SearchCommand's defensive dependency guard clause only - see the identical rationale
// in ComposeMailCommand.test.ts. Every real Search behavior (GAL matching, Range paging, the 400 branches) is
// exercised via real HTTP+DB requests in test/routes/{mongo,sql}/EasRoute.test.ts.
import config from "../config.js";
import { ObjectFactory } from "@rapidrest/service-core";
import { Logger } from "@rapidrest/core";
import { SearchCommandMongo } from "../../src/commands/mongo/SearchCommandMongo.js";
import type { EasCommandContext } from "../../src/EasCommandHandler.js";

describe("SearchCommand Tests (guard clause only)", () => {
    it("handle() throws INTERNAL_ERROR when a required dependency is not set.", async () => {
        const objectFactory = new ObjectFactory(config, Logger());
        const command = objectFactory.newInstance<SearchCommandMongo>(SearchCommandMongo, { initialize: false });

        await expect(command.handle({})).rejects.toThrow(/internal error/i);
    });
});
