///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
// Isolated unit test for the MoveItems branch a real single request can't reach deterministically: the update
// itself failing (a concurrent edit's version conflict between the read and the write). Every other status is
// exercised over real HTTP+DB in test/routes/{mongo,sql}/EasRoute.test.ts.
import config from "../config.js";
import { ObjectFactory } from "@rapidrest/service-core";
import { Logger } from "@rapidrest/core";
import { MoveItemsCommandMongo } from "../../src/commands/mongo/MoveItemsCommandMongo.js";
import { childText, element, findChildren, textElement } from "../../src/codec/WbxmlElement.js";
import { WbxmlCodePage } from "../../src/codec/WbxmlCodePages.js";
import type { EasCommandContext } from "../../src/EasCommandHandler.js";

describe("MoveItemsCommand Tests (isolated)", () => {
    it("Reports Status 7 for a move whose update fails, without aborting the other moves in the request.", async () => {
        const command = new ObjectFactory(config, Logger()).newInstance<MoveItemsCommandMongo>(MoveItemsCommandMongo, { initialize: false }) as any;
        const messages: Record<string, any> = {
            locked: { uid: "locked", version: 1, folderUid: "inbox", mailboxUid: "mbx" },
            fine: { uid: "fine", version: 1, folderUid: "inbox", mailboxUid: "mbx" },
        };
        command.messageRepo = {
            findOne: vi.fn().mockImplementation(async (uid: string) => messages[uid]),
            update: vi.fn().mockImplementation(async (values: any) => {
                if (values.uid === "locked") {
                    throw new Error("version conflict");
                }
                return values;
            }),
        };
        command.folderRepo = { findOne: vi.fn().mockResolvedValue({ uid: "archive", mailboxUid: "mbx" }) };
        command.aclUtils = { hasPermission: vi.fn().mockResolvedValue(true) };
        const move = (uid: string) =>
            element(WbxmlCodePage.Move, "Move", [
                textElement(WbxmlCodePage.Move, "SrcMsgId", uid),
                textElement(WbxmlCodePage.Move, "SrcFldId", "inbox"),
                textElement(WbxmlCodePage.Move, "DstFldId", "archive"),
            ]);

        const response = await command.handle({ user: { uid: "u" }, request: element(WbxmlCodePage.Move, "MoveItems", [move("locked"), move("fine")]) });

        expect(findChildren(response, "Response").map((r) => [childText(r, "SrcMsgId"), childText(r, "Status"), childText(r, "DstMsgId")])).toEqual([
            ["locked", "7", undefined],
            ["fine", "3", "fine"],
        ]);
    });
});
