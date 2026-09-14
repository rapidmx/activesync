///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
// Isolated unit tests for SearchCommand's defensive dependency guard clauses and the Mailbox store's query
// batching (one message lookup for every hit, one ACL check per distinct folder), which a real HTTP round trip
// can't observe. Every real Search behavior (GAL matching, Range paging, the 400 branches) is exercised via
// real HTTP+DB requests in test/routes/{mongo,sql}/EasRoute.test.ts.
import config from "../config.js";
import { ObjectFactory } from "@rapidrest/service-core";
import { Logger } from "@rapidrest/core";
import { SearchCommandMongo } from "../../src/commands/mongo/SearchCommandMongo.js";
import { element, findChild, findChildren, childText, textElement, type WbxmlElement } from "../../src/codec/WbxmlElement.js";
import { WbxmlCodePage } from "../../src/codec/WbxmlCodePages.js";
import type { EasCommandContext } from "../../src/EasCommandHandler.js";

function galRequest(query: string): WbxmlElement {
    return element(WbxmlCodePage.Search, "Search", [
        element(WbxmlCodePage.Search, "Store", [
            textElement(WbxmlCodePage.Search, "Name", "GAL"),
            textElement(WbxmlCodePage.Search, "Query", query),
        ]),
    ]);
}

function mailboxRequest(freeText: string): WbxmlElement {
    return element(WbxmlCodePage.Search, "Search", [
        element(WbxmlCodePage.Search, "Store", [
            textElement(WbxmlCodePage.Search, "Name", "Mailbox"),
            element(WbxmlCodePage.Search, "Query", [
                element(WbxmlCodePage.Search, "And", [
                    textElement(WbxmlCodePage.AirSync, "Class", "Email"),
                    textElement(WbxmlCodePage.Search, "FreeText", freeText),
                ]),
            ]),
        ]),
    ]);
}

function buildCommand(deps: Record<string, any> = {}): SearchCommandMongo {
    const objectFactory = new ObjectFactory(config, Logger());
    const command = objectFactory.newInstance<SearchCommandMongo>(SearchCommandMongo, { initialize: false });
    Object.assign(command as any, {
        contactRepo: { find: vi.fn().mockResolvedValue([]) },
        messageRepo: { find: vi.fn().mockResolvedValue([]) },
        emailAdapter: {
            toApplicationDataBatch: vi.fn(async (messages: any[]) =>
                messages.map(() => element(WbxmlCodePage.AirSync, "ApplicationData", [])),
            ),
        },
        aclUtils: { hasPermission: vi.fn().mockResolvedValue(true) },
        searchProvider: undefined,
        ...deps,
    });
    return command;
}

describe("SearchCommand Tests", () => {
    it("handle() throws INTERNAL_ERROR when a required dependency is not set.", async () => {
        const objectFactory = new ObjectFactory(config, Logger());
        const command = objectFactory.newInstance<SearchCommandMongo>(SearchCommandMongo, { initialize: false });

        await expect(command.handle({})).rejects.toThrow(/internal error/i);
    });

    it("Answers a GAL search without any SearchProvider configured.", async () => {
        const command = buildCommand();
        const response = await command.handle({ mailboxUid: "mbx-1", request: galRequest("Jane") } as EasCommandContext);
        expect(childText(findChild(findChild(response!, "Response")!, "Store")!, "Status")).toBe("1");
    });

    it("Throws INTERNAL_ERROR for a Mailbox search when no SearchProvider is configured.", async () => {
        const command = buildCommand();
        await expect(command.handle({ mailboxUid: "mbx-1", request: mailboxRequest("x") } as EasCommandContext)).rejects.toThrow(
            /internal error/i,
        );
    });

    it("Truncates an over-long GAL query so its escaped regex fits service-core's pattern length limit.", async () => {
        const find = vi.fn().mockResolvedValue([]);
        const command = buildCommand({ contactRepo: { find } });
        await command.handle({ mailboxUid: "mbx-1", request: galRequest(".".repeat(300)) } as EasCommandContext);
        expect(find).toHaveBeenCalledTimes(4);
        for (const [query] of find.mock.calls) {
            const field = Object.keys(query).find((key) => key !== "mailboxUid" && key !== "limit")!;
            const pattern = /^regex\((.*)\)$/.exec(query[field])![1];
            expect(pattern).toBe("\\.".repeat(50));
        }
    });

    it("Mailbox: fetches every hit in one query and checks READ once per folder, preserving relevance order.", async () => {
        const messages = [
            { uid: "m1", folderUid: "f1" },
            { uid: "m2", folderUid: "f2" },
            { uid: "m3", folderUid: "f1" },
            { uid: "m4", folderUid: "f3" },
        ];
        const messageFind = vi.fn(async (query: any) => {
            const uids: string[] = /^in\((.*)\)$/.exec(query.uid)![1].split(",");
            return messages.filter((message) => uids.includes(message.uid));
        });
        const hasPermission = vi.fn(async (_user: any, folderUid: string) => folderUid !== "f2");
        const searchProvider = {
            search: vi.fn().mockResolvedValue({
                results: ["m3", "stale", "m2", "m1", "m4"].map((entityUid) => ({ entityType: "message", entityUid, score: 1 })),
            }),
        };
        const command = buildCommand({ messageRepo: { find: messageFind }, aclUtils: { hasPermission }, searchProvider });

        const response = await command.handle({ mailboxUid: "mbx-1", request: mailboxRequest("x") } as EasCommandContext);

        expect(messageFind).toHaveBeenCalledTimes(1);
        expect(hasPermission).toHaveBeenCalledTimes(3);
        const store = findChild(findChild(response!, "Response")!, "Store")!;
        expect(childText(store, "Total")).toBe("3");
        expect(findChildren(store, "Result").map((result) => childText(result, "ServerId"))).toEqual(["m3", "m1", "m4"]);
    });
});
