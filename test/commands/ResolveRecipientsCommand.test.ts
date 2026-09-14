///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
// Isolated unit tests for ResolveRecipientsCommand's per-recipient failure isolation and regex-pattern bounding,
// which need an injected repo failure / an inspected query a real HTTP round trip can't provide. Real matching
// behavior is exercised via real HTTP+DB requests in test/routes/{mongo,sql}/EasRoute.test.ts.
import config from "../config.js";
import { ApiError, Logger } from "@rapidrest/core";
import { ApiErrors, ObjectFactory } from "@rapidrest/service-core";
import { ResolveRecipientsCommandMongo } from "../../src/commands/mongo/ResolveRecipientsCommandMongo.js";
import { element, findChildren, childText, textElement, type WbxmlElement } from "../../src/codec/WbxmlElement.js";
import { WbxmlCodePage } from "../../src/codec/WbxmlCodePages.js";
import type { EasCommandContext } from "../../src/EasCommandHandler.js";

function resolveRequest(toValues: string[]): WbxmlElement {
    return element(
        WbxmlCodePage.ResolveRecipients,
        "ResolveRecipients",
        toValues.map((v) => textElement(WbxmlCodePage.ResolveRecipients, "To", v)),
    );
}

function buildCommand(find: ReturnType<typeof vi.fn>): ResolveRecipientsCommandMongo {
    const objectFactory = new ObjectFactory(config, Logger());
    const command = objectFactory.newInstance<ResolveRecipientsCommandMongo>(ResolveRecipientsCommandMongo, { initialize: false });
    (command as any).contactRepo = { find };
    return command;
}

describe("ResolveRecipientsCommand Tests", () => {
    it("Reports a failed lookup as that recipient's own Status 4 without failing the other recipients.", async () => {
        const find = vi.fn(async (query: any) => {
            if (Object.values(query).some((value) => String(value).includes("Broken"))) {
                throw new ApiError(ApiErrors.INVALID_REQUEST, 400, "boom");
            }
            return [{ uid: "c1", displayName: "Jane Doe", emails: [{ address: "jane@example.com" }] }];
        });
        const command = buildCommand(find);

        const response = await command.handle({ mailboxUid: "mbx-1", request: resolveRequest(["Broken", "Jane"]) } as EasCommandContext);

        const responses = findChildren(response!, "Response");
        expect(responses.map((r) => childText(r, "Status"))).toEqual(["4", "1"]);
        expect(childText(response!, "Status")).toBe("1");
    });

    it("Truncates an over-long query so its escaped regex fits service-core's pattern length limit.", async () => {
        const find = vi.fn().mockResolvedValue([]);
        const command = buildCommand(find);

        await command.handle({ mailboxUid: "mbx-1", request: resolveRequest(["(".repeat(80) + "abc"]) } as EasCommandContext);

        expect(find).toHaveBeenCalled();
        for (const [query] of find.mock.calls) {
            const field = Object.keys(query).find((key) => key !== "mailboxUid")!;
            const pattern = /^regex\((.*)\)$/.exec(query[field])![1];
            expect(pattern).toBe("\\(".repeat(50));
        }
    });

    it("Fails the whole command with top-level Status 6 when a lookup fails for a non-request reason.", async () => {
        for (const failure of [new Error("connection refused"), new ApiError(ApiErrors.INTERNAL_ERROR, 500, "db down")]) {
            const find = vi.fn().mockRejectedValue(failure);
            const command = buildCommand(find);

            const response = await command.handle({ mailboxUid: "mbx-1", request: resolveRequest(["Jane", "John"]) } as EasCommandContext);

            expect(childText(response!, "Status")).toBe("6");
            expect(findChildren(response!, "Response")).toEqual([]);
            expect(find).toHaveBeenCalledTimes(3); // Stopped at the first recipient.
        }
    });

    it("Rejects more than 100 To elements with top-level Status 5 without querying.", async () => {
        const find = vi.fn().mockResolvedValue([]);
        const command = buildCommand(find);

        const response = await command.handle({
            mailboxUid: "mbx-1",
            request: resolveRequest(Array.from({ length: 101 }, (_, i) => `Name${i}`)),
        } as EasCommandContext);

        expect(childText(response!, "Status")).toBe("5");
        expect(findChildren(response!, "Response")).toEqual([]);
        expect(find).not.toHaveBeenCalled();

        const atLimit = await command.handle({
            mailboxUid: "mbx-1",
            request: resolveRequest(Array.from({ length: 100 }, (_, i) => `Name${i}`)),
        } as EasCommandContext);
        expect(childText(atLimit!, "Status")).toBe("1");
        expect(findChildren(atLimit!, "Response")).toHaveLength(100);
    });

    it("Reports an empty or whitespace-only To as Status 4 without a match-everything query.", async () => {
        const find = vi.fn().mockResolvedValue([{ uid: "c1", displayName: "Jane Doe", emails: [{ address: "jane@example.com" }] }]);
        const command = buildCommand(find);

        const response = await command.handle({ mailboxUid: "mbx-1", request: resolveRequest(["", "   "]) } as EasCommandContext);

        expect(findChildren(response!, "Response").map((r) => childText(r, "Status"))).toEqual(["4", "4"]);
        expect(find).not.toHaveBeenCalled();
    });
});
