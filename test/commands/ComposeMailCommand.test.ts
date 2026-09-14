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
import { stripHeader } from "../../src/commands/ComposeMailCommand.js";
import { element, opaqueElement } from "../../src/codec/WbxmlElement.js";
import { WbxmlCodePage } from "../../src/codec/WbxmlCodePages.js";
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
        (command as any).mailboxRepo = {};
        (command as any).blobStore = {};
        (command as any).mailTransport = {};
        (command as any).scanPipeline = {};

        await expect(command.handle({ request: undefined })).rejects.toThrow(/invalid/i);
    });

    it("handle() throws NOT_FOUND when the caller's own mailbox has vanished, before relaying anything.", async () => {
        const command = objectFactory.newInstance<SendMailCommandMongo>(SendMailCommandMongo, { initialize: false });
        const send = vi.fn();
        (command as any).folderRepo = {};
        (command as any).messageRepo = {};
        (command as any).mailboxRepo = { findOne: vi.fn().mockResolvedValue(undefined) };
        (command as any).blobStore = {};
        (command as any).mailTransport = { send };
        (command as any).scanPipeline = {};
        const mime = Buffer.from("From: me@example.com\r\nTo: you@example.com\r\nSubject: Hi\r\n\r\nBody");
        const request = element(WbxmlCodePage.ComposeMail, "SendMail", [opaqueElement(WbxmlCodePage.ComposeMail, "MIME", mime)]);

        await expect((command as any).handle({ mailboxUid: "gone", request })).rejects.toThrow(/no resource could be found/i);
        expect(send).not.toHaveBeenCalled();
    });

    describe("stripHeader", () => {
        it("Removes every occurrence of the header, case-insensitively, with its folded continuation lines, keeping other folded headers.", () => {
            const raw = Buffer.from(
                ["From: me@example.com", "Bcc: a@example.com,", " b@example.com", "Subject: long", "\tsubject continued", "bcc: c@example.com", "", "Bcc: in the body stays"].join("\r\n"),
            );
            expect(stripHeader(raw, "Bcc").toString("latin1")).toBe(
                ["From: me@example.com", "Subject: long", "\tsubject continued", "", "Bcc: in the body stays"].join("\r\n"),
            );
        });

        it("Handles LF-only messages, a message with no body at all, and preserves non-UTF-8 bytes.", () => {
            expect(stripHeader(Buffer.from("To: x\nBcc: y\n\nbody\r\n\r\nmore"), "bcc").toString("latin1")).toBe("To: x\n\nbody\r\n\r\nmore");
            expect(stripHeader(Buffer.from("To: x\r\nBcc: y"), "bcc").toString("latin1")).toBe("To: x\r\n");
            const binary = Buffer.concat([Buffer.from("X-Bin: "), Buffer.from([0xff, 0xfe]), Buffer.from("\r\nBcc: z\r\n\r\n")]);
            expect(stripHeader(binary, "bcc")).toEqual(Buffer.concat([Buffer.from("X-Bin: "), Buffer.from([0xff, 0xfe]), Buffer.from("\r\n\r\n")]));
        });
    });
});
