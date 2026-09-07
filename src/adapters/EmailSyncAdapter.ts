///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import * as crypto from "crypto";
import { ObjectDecorators } from "@rapidrest/core";
import { WbxmlCodePage } from "../codec/WbxmlCodePages.js";
import { childText, element, findChild, textElement, type WbxmlElement } from "../codec/WbxmlElement.js";
import type { EasCollectionSyncAdapter } from "./EasCollectionSyncAdapter.js";
import { type BlobStore, type Mailbox, type Message, type Recipient, MessageImportance, RecipientType } from "@rapidmx/restapi";
const { Inject } = ObjectDecorators;

/** MS-ASEMAIL `Importance`: 0=Low, 1=Normal, 2=High. */
const IMPORTANCE_CODES: Record<MessageImportance, string> = {
    [MessageImportance.LOW]: "0",
    [MessageImportance.NORMAL]: "1",
    [MessageImportance.HIGH]: "2",
};

const IMPORTANCE_BY_CODE: Record<string, MessageImportance> = {
    "0": MessageImportance.LOW,
    "1": MessageImportance.NORMAL,
    "2": MessageImportance.HIGH,
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
 * Also handles client-originated `Add`/`Change` for Drafts (`SyncCommand`'s own doc comment covers why this is
 * the only `Email` write EAS itself allows) - a plain-text-only pragmatic subset: no HTML body, no attachments
 * (mirrors `ComposeMailCommand`'s own already-documented attachment gap).
 *
 * @author Jean-Philippe Steinmetz
 */
export class EmailSyncAdapter implements EasCollectionSyncAdapter<Message> {
    public readonly collectionClass = "Email";

    @Inject("BlobStore")
    private blobStore?: BlobStore;

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

    /**
     * `Message.bodyBlobKey` is documented (see the `Message` interface itself) as holding raw MIME "unmodified
     * from ingestion/send" - `ItemOperationsCommand.fetchMessage` parses it with `simpleParser` unconditionally
     * for every message, Draft or not. A Draft's plain-text body is therefore wrapped in a minimal valid
     * RFC 5322 message here (via `buildPlainTextMime`) rather than stored as bare text, so that contract holds
     * for every consumer, not just this write path - a Draft created/edited via `Sync` must `Fetch` correctly
     * the same way any other message does.
     */
    public async fromApplicationData(el: WbxmlElement, existing?: Message): Promise<Partial<Message>> {
        const partial: Partial<Message> = {};

        const subject = childText(el, "Subject");
        if (subject !== undefined) partial.subject = subject;

        const to = childText(el, "To");
        const cc = childText(el, "Cc");
        if (to !== undefined || cc !== undefined) {
            partial.recipients = [
                ...(to !== undefined ? parseAddressList(to, RecipientType.TO) : []),
                ...(cc !== undefined ? parseAddressList(cc, RecipientType.CC) : []),
            ];
        }

        const importance = childText(el, "Importance");
        if (importance !== undefined) {
            partial.importance = IMPORTANCE_BY_CODE[importance] ?? MessageImportance.NORMAL;
        }

        const read = childText(el, "Read");
        const flag = childText(el, "Flag");
        if (read !== undefined || flag !== undefined) {
            const baseFlags = existing?.flags ?? { read: false, flagged: false, answered: false, forwarded: false };
            partial.flags = {
                ...baseFlags,
                ...(read !== undefined ? { read: read === "1" } : {}),
                ...(flag !== undefined ? { flagged: flag === "1" } : {}),
            };
        }

        const bodyEl = findChild(el, "Body");
        if (bodyEl) {
            const text = childText(bodyEl, "Data") ?? "";
            // Reuse the existing blob key on a Change (overwriting its content) rather than minting a new one
            // - a fresh key is only needed the first time a body is set (a bare `existing.bodyBlobKey` of ""
            // means an earlier Add never included a Body element at all).
            const bodyBlobKey = existing?.bodyBlobKey || `bodies/${crypto.randomUUID()}`;
            const mime = buildPlainTextMime({
                subject: partial.subject ?? existing?.subject ?? "",
                from: existing?.from,
                recipients: partial.recipients ?? existing?.recipients ?? [],
                date: existing?.sentDate ?? new Date(),
                text,
            });
            await this.blobStore!.put(bodyBlobKey, Buffer.from(mime, "utf-8"), { contentType: "message/rfc822" });
            partial.bodyBlobKey = bodyBlobKey;
            partial.bodyPreview = text.slice(0, 200);
        }

        return partial;
    }

    /** Defaults for a brand-new Draft created via a client-originated `Add` - `from` is the caller's own
     * mailbox address, per `ComposeMailCommand`'s identical `{ address, type: RecipientType.TO }` shape
     * convention for a `from` field (the `Recipient` struct's `type` is only meaningful for real recipients;
     * it's reused here as a harmless placeholder). */
    public newEntityDefaults(mailbox: Mailbox): Partial<Message> {
        return {
            messageId: `<${crypto.randomUUID()}@eas>`,
            subject: "",
            from: { address: mailbox.primarySmtpAddress, displayName: mailbox.displayName, type: RecipientType.TO },
            recipients: [],
            sentDate: new Date(),
            receivedDate: new Date(),
            bodyBlobKey: "",
            bodyPreview: "",
            flags: { read: true, flagged: false, answered: false, forwarded: false },
            importance: MessageImportance.NORMAL,
            references: [],
            hasAttachments: false,
        };
    }
}

function formatAddress(address: string, displayName?: string): string {
    return displayName ? `${displayName} <${address}>` : address;
}

/** Parses a `;`/`,`-separated address list (`"Name <a@x.com>; b@y.com"`, or the bare-address-only form this
 * adapter's own `toApplicationData` emits) into `Recipient`s of `type`. */
function parseAddressList(value: string, type: RecipientType): Recipient[] {
    return value
        .split(/[;,]/)
        .map((part) => part.trim())
        .filter((part) => part.length > 0)
        .map((part) => {
            const match = /^(.*)<(.+)>$/.exec(part);
            return match
                ? { address: match[2].trim(), displayName: match[1].trim() || undefined, type }
                : { address: part, type };
        });
}

/** Strips CR/LF from a value about to be interpolated into a single RFC 5322 header line. `Subject`/`To`/`Cc`
 * arrive from client-controlled WBXML inline strings (`WbxmlDecoder.readCString()`, which terminates only on a
 * NUL byte - literal `\r`/`\n` bytes pass through untouched), so without this a crafted value like
 * `"Hi\r\nBcc: attacker@evil.com"` would inject an arbitrary extra header line (or, via a blank line, a forged
 * second message) into the constructed MIME below. Folds onto a single line rather than rejecting outright -
 * a real device is never expected to send this, but a header value silently losing its embedded newlines is
 * safer than the request failing outright over what a client will never notice either way. */
function sanitizeHeaderValue(value: string): string {
    return value.replace(/[\r\n]+/g, " ");
}

/** Builds a minimal, valid RFC 5322 plain-text message - just enough structure for `simpleParser` (used by
 * `ItemOperationsCommand.fetchMessage`) to read it back correctly. No multipart/HTML/attachments - matches this
 * adapter's own documented pragmatic-subset scope. */
function buildPlainTextMime(parts: { subject: string; from?: Recipient; recipients: Recipient[]; date: Date; text: string }): string {
    const to = parts.recipients.filter((r) => r.type === RecipientType.TO).map((r) => formatAddress(r.address, r.displayName));
    const cc = parts.recipients.filter((r) => r.type === RecipientType.CC).map((r) => formatAddress(r.address, r.displayName));
    const headers = [
        ...(parts.from ? [`From: ${sanitizeHeaderValue(formatAddress(parts.from.address, parts.from.displayName))}`] : []),
        ...(to.length > 0 ? [`To: ${sanitizeHeaderValue(to.join(", "))}`] : []),
        ...(cc.length > 0 ? [`Cc: ${sanitizeHeaderValue(cc.join(", "))}`] : []),
        `Subject: ${sanitizeHeaderValue(parts.subject)}`,
        `Date: ${parts.date.toUTCString()}`,
        "MIME-Version: 1.0",
        "Content-Type: text/plain; charset=utf-8",
    ];
    return `${headers.join("\r\n")}\r\n\r\n${parts.text}`;
}
