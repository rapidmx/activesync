///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import { WbxmlCodePage } from "../codec/WbxmlCodePages.js";
import { element, textElement, type WbxmlElement } from "../codec/WbxmlElement.js";
import type { EasCollectionSyncAdapter } from "./EasCollectionSyncAdapter.js";
import { type Message, MessageImportance, RecipientType } from "@rapidmx/restapi";

/** MS-ASEMAIL `Importance`: 0=Low, 1=Normal, 2=High. */
const IMPORTANCE_CODES: Record<MessageImportance, string> = {
    [MessageImportance.LOW]: "0",
    [MessageImportance.NORMAL]: "1",
    [MessageImportance.HIGH]: "2",
};

/** MS-ASAIRSYNCBASE `Body.Type`: 1 = plain text, 2 = HTML, 3 = RTF, 4 = MIME. */
const BODY_TYPE_PLAIN_TEXT = "1";

/**
 * Maps `Message` to/from the EAS `Sync` `Email` collection class (MS-ASEMAIL). Only a plain-text preview of the
 * body is included here (`Message.bodyPreview`, always already loaded on the entity, `Truncated: 1`) rather
 * than the full sanitized HTML body from the `BlobStore` - a real device fetches the full body on demand via
 * `ItemOperations`' `Fetch` (see the architecture plan's command table), the same two-step "list, then fetch
 * body" flow every real EAS client already implements for exactly this reason (bodies can be large; a sync
 * window's Add/Change list shouldn't have to pull every one of them from blob storage up front).
 *
 * @author Jean-Philippe Steinmetz
 */
export class EmailSyncAdapter implements EasCollectionSyncAdapter<Message> {
    public readonly collectionClass = "Email";

    public toApplicationData(message: Message): WbxmlElement {
        const to = message.recipients.filter((r) => r.type === RecipientType.TO).map((r) => r.address);
        const cc = message.recipients.filter((r) => r.type === RecipientType.CC).map((r) => r.address);

        return element(WbxmlCodePage.AirSync, "ApplicationData", [
            textElement(WbxmlCodePage.Email, "Subject", message.subject),
            textElement(WbxmlCodePage.Email, "From", formatAddress(message.from.address, message.from.displayName)),
            ...(to.length > 0 ? [textElement(WbxmlCodePage.Email, "To", to.join("; "))] : []),
            ...(cc.length > 0 ? [textElement(WbxmlCodePage.Email, "Cc", cc.join("; "))] : []),
            textElement(WbxmlCodePage.Email, "DateReceived", message.receivedDate.toISOString()),
            textElement(WbxmlCodePage.Email, "Importance", IMPORTANCE_CODES[message.importance]),
            textElement(WbxmlCodePage.Email, "Read", message.flags.read ? "1" : "0"),
            textElement(WbxmlCodePage.Email, "Flag", message.flags.flagged ? "1" : "0"),
            element(WbxmlCodePage.AirSyncBase, "Body", [
                textElement(WbxmlCodePage.AirSyncBase, "Type", BODY_TYPE_PLAIN_TEXT),
                textElement(WbxmlCodePage.AirSyncBase, "EstimatedDataSize", String(Buffer.byteLength(message.bodyPreview, "utf8"))),
                textElement(WbxmlCodePage.AirSyncBase, "Truncated", "1"),
                textElement(WbxmlCodePage.AirSyncBase, "Data", message.bodyPreview),
            ]),
        ]);
    }
}

function formatAddress(address: string, displayName?: string): string {
    return displayName ? `${displayName} <${address}>` : address;
}
