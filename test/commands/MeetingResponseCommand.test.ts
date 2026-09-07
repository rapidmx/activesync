///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
// Isolated unit tests for MeetingResponseCommand's defensive guard clauses only. The dependency-missing guard
// follows the same rationale as ComposeMailCommand.test.ts's own; the "mailbox vanished" 404 is a genuine
// race-condition-only branch (BaseEasRoute already resolved ctx.mailboxUid to a real, currently-existing
// mailbox moments before dispatching to this handler, so it can only return undefined here if the mailbox was
// deleted in between) - exercised with a directly-poked repo double rather than an unreproducible real race.
// Every other MeetingResponse behavior (accept/decline, threading, 404/403/400 branches) is exercised via real
// HTTP+DB requests in test/routes/{mongo,sql}/EasRoute.test.ts.
import config from "../config.js";
import { ObjectFactory } from "@rapidrest/service-core";
import { Logger } from "@rapidrest/core";
import { MeetingResponseCommandMongo } from "../../src/commands/mongo/MeetingResponseCommandMongo.js";
import { element, textElement } from "../../src/codec/WbxmlElement.js";
import { WbxmlCodePage } from "../../src/codec/WbxmlCodePages.js";
import type { EasCommandContext } from "../../src/EasCommandHandler.js";

describe("MeetingResponseCommand Tests (guard clauses only)", () => {
    it("handle() throws INTERNAL_ERROR when a required dependency is not set.", async () => {
        const objectFactory = new ObjectFactory(config, Logger());
        const command = objectFactory.newInstance<MeetingResponseCommandMongo>(MeetingResponseCommandMongo, { initialize: false });

        await expect(command.handle({})).rejects.toThrow(/internal error/i);
    });

    it("handle() throws NOT_FOUND when the caller's own mailbox has vanished since being resolved.", async () => {
        const objectFactory = new ObjectFactory(config, Logger());
        const command = objectFactory.newInstance<MeetingResponseCommandMongo>(MeetingResponseCommandMongo, { initialize: false });
        (command as any).calendarEventRepo = {
            findOne: vi.fn().mockResolvedValue({ uid: "event-1", version: 1, folderUid: "folder-1", attendees: [] }),
        };
        (command as any).mailboxRepo = { findOne: vi.fn().mockResolvedValue(undefined) };
        (command as any).aclUtils = { hasPermission: vi.fn().mockResolvedValue(true) };

        const ctx = {
            user: { uid: "user-1", roles: [], scopes: [] },
            mailboxUid: "mbx-1",
            request: element(WbxmlCodePage.MeetingResponse, "MeetingResponse", [
                element(WbxmlCodePage.MeetingResponse, "Request", [
                    textElement(WbxmlCodePage.MeetingResponse, "UserResponse", "1"),
                    textElement(WbxmlCodePage.MeetingResponse, "RequestId", "event-1"),
                ]),
            ]),
        } as unknown as EasCommandContext;

        await expect(command.handle(ctx)).rejects.toThrow(/no resource could be found/i);
    });
});
