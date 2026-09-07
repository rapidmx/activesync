///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
// Isolated unit tests for SettingsCommand's defensive guard clauses only - see the identical rationale in
// MeetingResponseCommand.test.ts for why the "mailbox vanished" branch is exercised with a directly-poked repo
// double rather than a real HTTP request. Every other Settings behavior (UserInformation/DeviceInformation,
// the bare-request case) is exercised via real HTTP+DB requests in test/routes/{mongo,sql}/EasRoute.test.ts.
import config from "../config.js";
import { ObjectFactory } from "@rapidrest/service-core";
import { Logger } from "@rapidrest/core";
import { SettingsCommandMongo } from "../../src/commands/mongo/SettingsCommandMongo.js";
import { element } from "../../src/codec/WbxmlElement.js";
import { WbxmlCodePage } from "../../src/codec/WbxmlCodePages.js";
import type { EasCommandContext } from "../../src/EasCommandHandler.js";

describe("SettingsCommand Tests (guard clauses only)", () => {
    it("handle() throws INTERNAL_ERROR when a required dependency is not set.", async () => {
        const objectFactory = new ObjectFactory(config, Logger());
        const command = objectFactory.newInstance<SettingsCommandMongo>(SettingsCommandMongo, { initialize: false });

        await expect(command.handle({})).rejects.toThrow(/internal error/i);
    });

    it("handle() throws NOT_FOUND when the caller's own mailbox has vanished since being resolved (UserInformation).", async () => {
        const objectFactory = new ObjectFactory(config, Logger());
        const command = objectFactory.newInstance<SettingsCommandMongo>(SettingsCommandMongo, { initialize: false });
        (command as any).mailboxRepo = { findOne: vi.fn().mockResolvedValue(undefined) };

        const ctx = {
            mailboxUid: "mbx-1",
            request: element(WbxmlCodePage.Settings, "Settings", [
                element(WbxmlCodePage.Settings, "UserInformation", [element(WbxmlCodePage.Settings, "Get", [])]),
            ]),
        } as unknown as EasCommandContext;

        await expect(command.handle(ctx)).rejects.toThrow(/no resource could be found/i);
    });

    it("handle() throws NOT_FOUND when the caller's own mailbox has vanished since being resolved (Oof).", async () => {
        const objectFactory = new ObjectFactory(config, Logger());
        const command = objectFactory.newInstance<SettingsCommandMongo>(SettingsCommandMongo, { initialize: false });
        (command as any).mailboxRepo = { findOne: vi.fn().mockResolvedValue(undefined) };

        const ctx = {
            mailboxUid: "mbx-1",
            request: element(WbxmlCodePage.Settings, "Settings", [
                element(WbxmlCodePage.Settings, "Oof", [element(WbxmlCodePage.Settings, "Get", [])]),
            ]),
        } as unknown as EasCommandContext;

        await expect(command.handle(ctx)).rejects.toThrow(/no resource could be found/i);
    });
});
