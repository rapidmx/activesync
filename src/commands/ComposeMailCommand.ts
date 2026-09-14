///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import * as crypto from "crypto";
import { simpleParser, type AddressObject, type EmailAddress, type ParsedMail } from "mailparser";
import { ApiError, ObjectDecorators } from "@rapidrest/core";
import { ACLAction, ACLUtils, ApiErrorMessages, ApiErrors, ObjectFactory, RepoUtils } from "@rapidrest/service-core";
import { ScanPipeline } from "@rapidmx/restapi/scan";
import {
    BlobStore,
    findOrCreateWellKnownFolder,
    FolderType,
    type Mailbox,
    type Message,
    MessageImportance,
    RecipientType,
    RecoverableRepoUtils,
    scanAndRelay,
} from "@rapidmx/restapi";
import { childText, findChild, type WbxmlElement } from "../codec/WbxmlElement.js";
import type { EasCommandContext, EasCommandHandler } from "../EasCommandHandler.js";
const { Init, Inject, Logger } = ObjectDecorators;

/** Most envelope recipients (To + Cc + Bcc) one composed message may carry. */
export const MAX_COMPOSE_RECIPIENTS = 500;

/** Flattens mailparser's `AddressObject | AddressObject[] | undefined` union (grouped addresses can nest an
 * `AddressObject` per group) into a plain list of SMTP addresses, dropping any entry with no address (a
 * pure-group header with no direct member). */
function addressesOf(value: AddressObject | AddressObject[] | undefined): string[] {
    const objects: AddressObject[] = Array.isArray(value) ? value : value ? [value] : [];
    const addresses: string[] = [];
    for (const obj of objects) {
        for (const entry of obj.value) {
            collectAddresses(entry, addresses);
        }
    }
    return addresses;
}

function collectAddresses(entry: EmailAddress, out: string[]): void {
    if (entry.address) {
        out.push(entry.address);
    }
    for (const grouped of entry.group ?? []) {
        collectAddresses(grouped, out);
    }
}

/**
 * Returns a copy of `raw` with every top-level header named `name` (case-insensitive, including its folded
 * continuation lines) removed. Only the header block is touched; the body is copied verbatim. Works on the
 * `latin1` view of the bytes so no byte sequence is altered.
 */
export function stripHeader(raw: Buffer, name: string): Buffer {
    const text = raw.toString("latin1");
    const crlf = text.indexOf("\r\n\r\n");
    const lf = text.indexOf("\n\n");
    const end = crlf !== -1 && (lf === -1 || crlf < lf) ? crlf + 2 : lf !== -1 ? lf + 1 : text.length;
    const lines = text.slice(0, end).split(/(?<=\n)/);
    const kept: string[] = [];
    let dropping = false;
    const prefix = `${name.toLowerCase()}:`;
    for (const line of lines) {
        if (line.startsWith(" ") || line.startsWith("\t")) {
            if (!dropping) {
                kept.push(line);
            }
            continue;
        }
        dropping = line.toLowerCase().startsWith(prefix);
        if (!dropping) {
            kept.push(line);
        }
    }
    return Buffer.from(kept.join("") + text.slice(end), "latin1");
}

/**
 * Shared implementation for EAS `SendMail`, `SmartForward`, and `SmartReply` (MS-ASCMD `ComposeMail` namespace)
 * — all three submit a client-composed raw MIME body directly (`<Mime>`, opaque WBXML content) rather than
 * referencing a pre-existing draft `Message`, unlike the webmail REST API's `POST /messages/:id/send` (see
 * `BaseMessageRoute.send()`, which this class's `scanAndRelay()` call shares its scan-then-relay core with via
 * `MailSendUtils.ts`).
 *
 * **Sender and envelope checks** (the MIME is entirely device-controlled): every `From` address - and a `Sender`
 * header, if present - must be the caller's own mailbox's primary or alias address (HTTP 403 otherwise), so a
 * device can't send as anyone else; the envelope sender is that validated `From`. The envelope is capped at
 * `MAX_COMPOSE_RECIPIENTS` recipients (HTTP 400). `Bcc` recipients are delivered via the envelope, but the `Bcc`
 * header itself is stripped from the relayed copy so other recipients never see it (the Sent Items copy keeps it).
 *
 * **Pragmatic subset, deliberately not the full MS-ASCMD semantics**:
 * - `SmartForward`/`SmartReply`'s `<Source>` (the message being forwarded/replied to) is used only to thread
 * the outgoing message (`inReplyTo`/`references`) and to flip the original's `Answered`/`Forwarded` flag - the
 * real spec has the *server* splice the original message's full content into the outgoing MIME; this subset
 * expects the client's own `<Mime>` to already be the complete outgoing message. The flag flip needs `UPDATE` on
 * the original's folder and is best-effort: the message has already been sent, so a denied or conflicting flag
 * update is logged, never turned into a failed request.
 * - `ReplaceMime`/`AccountId`/`InstanceId` are not read - single-account, non-recurring-meeting compose only.
 * - Attachments present in the composed MIME are relayed correctly but are not additionally persisted as
 * `Attachment` records on the saved Sent Items copy (`Message.hasAttachments` is still set).
 *
 * `folderClass`/`messageClass`/`mailboxClass` are supplied by the Mongo/SQL concrete subclasses, and
 * `markOriginal()` by the `SmartForwardCommand`/`SmartReplyCommand` subclasses.
 *
 * @author Jean-Philippe Steinmetz
 */
export abstract class ComposeMailCommand implements EasCommandHandler {
    public abstract readonly command: string;

    protected abstract folderClass: any;
    protected abstract messageClass: any;
    protected abstract mailboxClass: any;

    // Automatically injected by ObjectFactory on instantiation
    private _objectFactory?: ObjectFactory;

    protected folderRepo?: RecoverableRepoUtils<any>;
    protected messageRepo?: RecoverableRepoUtils<any>;
    protected mailboxRepo?: RepoUtils<any>;

    @Inject("BlobStore")
    private blobStore?: BlobStore;

    @Inject("MailTransport")
    private mailTransport?: any;

    @Inject(ScanPipeline)
    private scanPipeline?: ScanPipeline;

    @Inject(ACLUtils)
    private aclUtils?: ACLUtils;

    @Logger
    private logger: any;

    @Init
    public async init(): Promise<void> {
        this.folderRepo = await this._objectFactory!.newInstance(RecoverableRepoUtils, {
            name: this.folderClass.name,
            args: [this.folderClass],
        });
        this.messageRepo = await this._objectFactory!.newInstance(RecoverableRepoUtils, {
            name: this.messageClass.name,
            args: [this.messageClass],
        });
        this.mailboxRepo = await this._objectFactory!.newInstance(RepoUtils, {
            name: this.mailboxClass.name,
            args: [this.mailboxClass],
        });
    }

    /** Called once the outgoing message has been sent, only when the request carried a `<Source>` the caller may
     * update - flips the referenced original message's own `Answered`/`Forwarded` flag. A no-op here; overridden by
     * the two subclasses that need it. */
    protected async markOriginal(_ctx: EasCommandContext, _original: Message & { uid: string }): Promise<void> {
        // No-op by default (plain SendMail has nothing to flag).
    }

    public async handle(ctx: EasCommandContext): Promise<WbxmlElement | undefined> {
        if (!this.folderRepo || !this.messageRepo || !this.mailboxRepo || !this.blobStore || !this.mailTransport || !this.scanPipeline) {
            throw new ApiError(ApiErrors.INTERNAL_ERROR, 500, ApiErrorMessages.INTERNAL_ERROR);
        }
        if (!ctx.request) {
            throw new ApiError(ApiErrors.INVALID_REQUEST, 400, ApiErrorMessages.INVALID_REQUEST);
        }

        // Registered as "MIME" (all caps) in WbxmlCodePages' ComposeMail table, per the published MS-ASWBXML
        // token name - not "Mime".
        const mimeEl = findChild(ctx.request, "MIME");
        const raw: Buffer | undefined = mimeEl?.opaque ?? (mimeEl?.text !== undefined ? Buffer.from(mimeEl.text, "utf-8") : undefined);
        if (!raw || raw.length === 0) {
            throw new ApiError(ApiErrors.INVALID_REQUEST, 400, "A SendMail/SmartForward/SmartReply request must include a MIME body.");
        }

        // A `SmartForward`/`SmartReply` request identifies the message being acted on via `<Source><ItemId>` -
        // the same `Message.uid` this library already exposes as `ServerId` in Sync/FolderSync responses.
        let original: (Message & { uid: string; version: number }) | undefined;
        const sourceEl = findChild(ctx.request, "Source");
        if (sourceEl) {
            const itemId = childText(sourceEl, "ItemId");
            if (!itemId) {
                throw new ApiError(ApiErrors.INVALID_REQUEST, 400, "Source is missing its required ItemId.");
            }
            const found = await this.messageRepo.findOne(itemId, { ignoreACL: true });
            if (!found) {
                throw new ApiError(ApiErrors.NOT_FOUND, 404, ApiErrorMessages.NOT_FOUND);
            }
            if (!(await this.aclUtils!.hasPermission(ctx.user, found.folderUid, ACLAction.READ))) {
                throw new ApiError(ApiErrors.AUTH_PERMISSION_FAILURE, 403, ApiErrorMessages.AUTH_PERMISSION_FAILURE);
            }
            original = found;
        }

        const parsed: ParsedMail = await simpleParser(raw);
        const fromAddresses: string[] = addressesOf(parsed.from);
        const envelopeFrom: string | undefined = fromAddresses[0];
        const envelopeTo: string[] = [...addressesOf(parsed.to), ...addressesOf(parsed.cc), ...addressesOf(parsed.bcc)];
        if (!envelopeFrom || envelopeTo.length === 0) {
            throw new ApiError(ApiErrors.INVALID_REQUEST, 400, "The composed Mime has no resolvable From/To address.");
        }
        if (envelopeTo.length > MAX_COMPOSE_RECIPIENTS) {
            throw new ApiError(ApiErrors.INVALID_REQUEST, 400, `A composed message may have at most ${MAX_COMPOSE_RECIPIENTS} recipients.`);
        }

        const mailbox: Mailbox | undefined = await this.mailboxRepo.findOne(ctx.mailboxUid, { ignoreACL: true });
        if (!mailbox) {
            throw new ApiError(ApiErrors.NOT_FOUND, 404, ApiErrorMessages.NOT_FOUND);
        }
        const ownAddresses = new Set([mailbox.primarySmtpAddress, ...(mailbox.aliasAddresses ?? [])].map((a) => a.toLowerCase()));
        const senderAddresses: string[] = addressesOf(parsed.headers.get("sender") as AddressObject | undefined);
        if ([...fromAddresses, ...senderAddresses].some((address) => !ownAddresses.has(address.toLowerCase()))) {
            throw new ApiError(ApiErrors.AUTH_PERMISSION_FAILURE, 403, "The composed message's From address is not one of this mailbox's addresses.");
        }

        const { sanitizedHtmlBlobKey } = await scanAndRelay(
            stripHeader(raw, "bcc"),
            envelopeFrom,
            envelopeTo,
            this.scanPipeline,
            this.mailTransport,
            this.blobStore,
        );

        if (findChild(ctx.request, "SaveInSentItems")) {
            const bodyBlobKey = `bodies/${crypto.randomUUID()}`;
            await this.blobStore.put(bodyBlobKey, raw, { contentType: "message/rfc822" });

            const sentFolder: any = await findOrCreateWellKnownFolder(
                this.folderRepo,
                this.folderClass,
                ctx.mailboxUid,
                FolderType.SENT_ITEMS,
                ctx.user,
            );

            await this.messageRepo.create(
                new this.messageClass({
                    folderUid: sentFolder.uid,
                    mailboxUid: ctx.mailboxUid,
                    messageId: parsed.messageId ?? `${crypto.randomUUID()}@eas`,
                    subject: parsed.subject ?? "",
                    from: { address: envelopeFrom, type: RecipientType.TO },
                    recipients: buildRecipients(parsed),
                    sentDate: new Date(),
                    receivedDate: new Date(),
                    bodyBlobKey,
                    sanitizedHtmlBlobKey,
                    bodyPreview: (parsed.text ?? "").slice(0, 200),
                    flags: { read: true, flagged: false, answered: false, forwarded: false },
                    importance: MessageImportance.NORMAL,
                    inReplyTo: original?.messageId,
                    references: original ? [...original.references, original.messageId] : [],
                    hasAttachments: (parsed.attachments?.length ?? 0) > 0,
                } as any),
                { ignoreACL: true, user: ctx.user },
            );
        }

        if (original) {
            // The message is already on its way - flagging the original is best-effort bookkeeping.
            try {
                if (await this.aclUtils!.hasPermission(ctx.user, original.folderUid, ACLAction.UPDATE)) {
                    await this.markOriginal(ctx, original);
                }
            } catch (err: any) {
                this.logger?.warn(`${this.command}: failed to flag original message ${original.uid}: ${err?.message}`);
            }
        }

        // Per MS-ASCMD: a successful SendMail/SmartForward/SmartReply response is an empty HTTP 200 body, not
        // a Status-coded WBXML document like FolderSync/Sync/Provision return.
        return undefined;
    }
}

function buildRecipients(parsed: ParsedMail): { address: string; type: RecipientType }[] {
    return [
        ...addressesOf(parsed.to).map((address) => ({ address, type: RecipientType.TO })),
        ...addressesOf(parsed.cc).map((address) => ({ address, type: RecipientType.CC })),
        ...addressesOf(parsed.bcc).map((address) => ({ address, type: RecipientType.BCC })),
    ];
}
