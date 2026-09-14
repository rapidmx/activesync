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
import { MAX_EMPTY_FOLDER_BATCHES } from "../../src/commands/ItemOperationsCommand.js";
import { encodeConversationId } from "../../src/adapters/EmailSyncAdapter.js";
import { childText, element, findChild, opaqueElement, textElement } from "../../src/codec/WbxmlElement.js";
import { WbxmlCodePage } from "../../src/codec/WbxmlCodePages.js";

describe("ItemOperationsCommand Tests (guard clause only)", () => {
    it("handle() throws INTERNAL_ERROR when a required dependency is not set.", async () => {
        const objectFactory = new ObjectFactory(config, Logger());
        const command = objectFactory.newInstance<ItemOperationsCommandMongo>(ItemOperationsCommandMongo, { initialize: false });

        await expect(command.handle({})).rejects.toThrow(/internal error/i);
    });

    describe("bulk operations (isolated)", () => {
        /** Builds a command over an in-memory folder of messages whose delete/update fails for the given uids. */
        function build(messages: any[], failing: Set<string>) {
            const objectFactory = new ObjectFactory(config, Logger());
            const command = objectFactory.newInstance<ItemOperationsCommandMongo>(ItemOperationsCommandMongo, { initialize: false }) as any;
            let rows = [...messages];
            const messageRepo = {
                find: vi.fn().mockImplementation(async (query: any) => rows.filter((m) => !query.folderUid || m.folderUid === query.folderUid).slice(0, query.limit)),
                delete: vi.fn().mockImplementation(async (uid: string) => {
                    if (failing.has(uid)) throw new Error("version conflict");
                    rows = rows.filter((m) => m.uid !== uid);
                }),
                update: vi.fn().mockImplementation(async (values: any) => {
                    if (failing.has(values.uid)) throw new Error("version conflict");
                    return values;
                }),
            };
            Object.assign(command, {
                folderRepo: { findOne: vi.fn().mockResolvedValue({ uid: "dest", mailboxUid: "mbx" }) },
                messageRepo,
                attachmentRepo: {},
                blobStore: {},
                aclUtils: { hasPermission: vi.fn().mockResolvedValue(true) },
                batchSize: 2,
            });
            return { command, messageRepo };
        }
        const ctx = (request: any) => ({ user: { uid: "u" }, mailboxUid: "mbx", request }) as unknown as EasCommandContext;
        const empty = () =>
            element(WbxmlCodePage.ItemOperations, "ItemOperations", [
                element(WbxmlCodePage.ItemOperations, "EmptyFolderContents", [textElement(WbxmlCodePage.AirSync, "CollectionId", "f1")]),
            ]);
        const emptyStatus = (response: any) => childText(findChild(findChild(response, "Response")!, "EmptyFolderContents")!, "Status");
        const messages = (count: number) => Array.from({ length: count }, (_, i) => ({ uid: `m${i}`, version: 1, folderUid: "f1", conversationId: "conv" }));

        it("EmptyFolderContents skips a message that fails to delete and reports Status 17, or Status 3 when nothing could be deleted.", async () => {
            const { command, messageRepo } = build(messages(5), new Set(["m1"]));
            expect(emptyStatus(await command.handle(ctx(empty())))).toBe("17");
            expect(messageRepo.delete).toHaveBeenCalledTimes(5);

            const { command: stuck } = build(messages(2), new Set(["m0", "m1"]));
            expect(emptyStatus(await stuck.handle(ctx(empty())))).toBe("3");

            const { command: clean } = build(messages(3), new Set());
            expect(emptyStatus(await clean.handle(ctx(empty())))).toBe("1");
        });

        it("EmptyFolderContents deletes at most MAX_EMPTY_FOLDER_BATCHES batches per request, reporting the rest as partial.", async () => {
            const { command, messageRepo } = build(messages(MAX_EMPTY_FOLDER_BATCHES * 2 + 1), new Set());
            expect(emptyStatus(await command.handle(ctx(empty())))).toBe("17");
            expect(messageRepo.delete).toHaveBeenCalledTimes(MAX_EMPTY_FOLDER_BATCHES * 2);
        });

        it("Move reports Status 17 when some messages of the conversation fail to move, and Status 3 when all do.", async () => {
            const move = () =>
                element(WbxmlCodePage.ItemOperations, "ItemOperations", [
                    element(WbxmlCodePage.ItemOperations, "Move", [
                        opaqueElement(WbxmlCodePage.ItemOperations, "ConversationId", encodeConversationId("conv")),
                        textElement(WbxmlCodePage.ItemOperations, "DstFldId", "dest"),
                    ]),
                ]);
            const moveStatus = (response: any) => childText(findChild(findChild(response, "Response")!, "Move")!, "Status");

            const { command } = build(messages(2), new Set(["m0"]));
            expect(moveStatus(await command.handle(ctx(move())))).toBe("17");
            const { command: failing } = build(messages(2), new Set(["m0", "m1"]));
            expect(moveStatus(await failing.handle(ctx(move())))).toBe("3");
        });
    });
});
