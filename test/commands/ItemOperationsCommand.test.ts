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
import { ModelUtils, ObjectFactory } from "@rapidrest/service-core";
import { Logger } from "@rapidrest/core";
import { ItemOperationsCommandMongo } from "../../src/commands/mongo/ItemOperationsCommandMongo.js";
import type { EasCommandContext } from "../../src/EasCommandHandler.js";
import { MAX_EMPTY_FOLDER_BATCHES } from "../../src/commands/ItemOperationsCommand.js";
import { encodeConversationId } from "../../src/adapters/EmailSyncAdapter.js";
import { childText, element, findChild, opaqueElement, textElement } from "../../src/codec/WbxmlElement.js";
import { WbxmlCodePage } from "../../src/codec/WbxmlCodePages.js";
import { createHash } from "crypto";
import { FolderType } from "@rapidmx/restapi";

describe("ItemOperationsCommand Tests (guard clause only)", () => {
    it("handle() throws INTERNAL_ERROR when a required dependency is not set.", async () => {
        const objectFactory = new ObjectFactory(config, Logger());
        const command = objectFactory.newInstance<ItemOperationsCommandMongo>(ItemOperationsCommandMongo, { initialize: false });

        await expect(command.handle({})).rejects.toThrow(/internal error/i);
    });

    describe("bulk operations (isolated)", () => {
        /** Builds a command over an in-memory folder of messages whose delete/update fails for the given uids. */
        function build(messages: any[], failing: Set<string>, folderTypes: Record<string, FolderType> = {}) {
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
                folderRepo: { findOne: vi.fn().mockImplementation(async (uid: string) => (uid === "gone" ? undefined : { uid, mailboxUid: "mbx", type: folderTypes[uid] })) },
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
        const messages = (count: number) => Array.from({ length: count }, (_, i) => ({ uid: `m${i}`, version: 1, folderUid: "f1", mailboxUid: "mbx", conversationId: "conv" }));

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

        const moveTo = (conversationId: string, dest: string = "dest") =>
            element(WbxmlCodePage.ItemOperations, "ItemOperations", [
                element(WbxmlCodePage.ItemOperations, "Move", [
                    opaqueElement(WbxmlCodePage.ItemOperations, "ConversationId", encodeConversationId(conversationId)),
                    textElement(WbxmlCodePage.ItemOperations, "DstFldId", dest),
                ]),
            ]);
        const statusOf = (response: any) => childText(findChild(findChild(response, "Response")!, "Move")!, "Status");

        it("Move exact-matches the ConversationId in memory, so an operator-shaped id never moves other conversations.", async () => {
            // The fake find ignores conversationId entirely, like a query parser reading `ne(conv)` as "not conv".
            const rows = [{ uid: "target", version: 1, folderUid: "f1", mailboxUid: "mbx", conversationId: "ne(conv)" }, messages(1)[0]];
            const { command, messageRepo } = build(rows, new Set());

            expect(statusOf(await command.handle(ctx(moveTo("ne(conv)"))))).toBe("1");
            expect(messageRepo.update.mock.calls.map(([values]: any[]) => values.uid)).toEqual(["target"]);
            expect(messageRepo.find.mock.calls[0][0].conversationId).toEqual(ModelUtils.literal("ne(conv)"));
        });

        it("Move looks an over-long ConversationId up by its bounded (hashed) value.", async () => {
            const longId = "c".repeat(300);
            const key = `sha256:${createHash("sha256").update(longId, "utf8").digest("hex")}`;
            const { command, messageRepo } = build([{ uid: "m", version: 1, folderUid: "f1", mailboxUid: "mbx", conversationId: key }], new Set());

            expect(statusOf(await command.handle(ctx(moveTo(longId))))).toBe("1");
            expect(messageRepo.find.mock.calls[0][0].conversationId).toEqual(ModelUtils.literal(key));
        });

        it("Move refuses Outbox, and Drafts for messages that aren't drafts, cancelling the send of a message leaving Outbox.", async () => {
            const folderTypes = { f1: FolderType.INBOX, drafts: FolderType.DRAFTS, outbox: FolderType.OUTBOX, queued: FolderType.OUTBOX, dest: FolderType.ARCHIVE };
            const { command, messageRepo } = build(messages(2), new Set(), folderTypes);
            expect(statusOf(await command.handle(ctx(moveTo("conv", "drafts"))))).toBe("3");
            expect(statusOf(await command.handle(ctx(moveTo("conv", "outbox"))))).toBe("3");
            expect(messageRepo.update).not.toHaveBeenCalled();

            const mixed = [
                { uid: "q", version: 1, folderUid: "queued", mailboxUid: "mbx", conversationId: "conv", scheduledSendTime: new Date() },
                { uid: "i", version: 1, folderUid: "f1", mailboxUid: "mbx", conversationId: "conv" },
            ];
            const { command: partial, messageRepo: partialRepo } = build(mixed, new Set(), folderTypes);
            expect(statusOf(await partial.handle(ctx(moveTo("conv", "drafts"))))).toBe("17");
            expect(partialRepo.update.mock.calls[0][0]).toEqual({ uid: "q", version: 1, folderUid: "drafts", scheduledSendTime: null });
        });

        it("EmptyFolderContents answers 404 for a folder that doesn't exist, never querying by the client's string.", async () => {
            const { command, messageRepo } = build(messages(1), new Set());
            const request = element(WbxmlCodePage.ItemOperations, "ItemOperations", [
                element(WbxmlCodePage.ItemOperations, "EmptyFolderContents", [textElement(WbxmlCodePage.AirSync, "CollectionId", "gone")]),
            ]);

            await expect(command.handle(ctx(request))).rejects.toMatchObject({ status: 404 });
            expect(messageRepo.find).not.toHaveBeenCalled();
        });
    });
});
