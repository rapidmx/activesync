///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import * as crypto from "crypto";
import { simpleParser, type AddressObject, type EmailAddress, type ParsedMail } from "mailparser";
import { ApiError, ObjectDecorators } from "@rapidrest/core";
import { ACLAction, ACLUtils, ApiErrorMessages, ApiErrors, ObjectFactory } from "@rapidrest/service-core";
import { ScanPipeline } from "@rapidmx/restapi/scan";
import {
    BlobStore,
    findOrCreateWellKnownFolder,
    FolderType,
    type Message,
    MessageImportance,
    RecipientType,
    RecoverableRepoUtils,
    scanAndRelay,
} from "@rapidmx/restapi";
import { childText, findChild, type WbxmlElement } from "../codec/WbxmlElement.js";
import type { EasCommandContext, EasCommandHandler } from "../EasCommandHandler.js";
const { Init, Inject } = ObjectDecorators;

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
 * Shared implementation for EAS `SendMail`, `SmartForward`, and `SmartReply` (MS-ASCMD `ComposeMail` namespace)
 * — all three submit a client-composed raw MIME body directly (`<Mime>`, opaque WBXML content) rather than
 * referencing a pre-existing draft `Message`, unlike the webmail REST API's `POST /messages/:id/send` (see
 * `BaseMessageRoute.send()`, which this class's `scanAndRelay()` call shares its scan-then-relay core with via
 * `MailSendUtils.ts`).
 *
 * **Pragmatic subset, deliberately not the full MS-ASCMD semantics**:
 * - `SmartForward`/`SmartReply`'s `<Source>` (the message being forwarded/replied to) is used only to thread
 * the outgoing message (`inReplyTo`/`references`) and to flip the original's `Answered`/`Forwarded` flag - the
 * real spec has the *server* splice the original message's full content into the outgoing MIME so the client
 * never has to download-then-reupload it; this pragmatic subset instead expects the client's own `<Mime>` to
 * already be the complete outgoing message (which is what every mainstream client's own compose UI naturally
 * produces once it has fetched the original for display), matching this library's "pragmatic subset, not full
 * fidelity" precedent elsewhere (e.g. `FolderSyncCommand`'s SyncKey replay-protection gap).
 * - `ReplaceMime`/`AccountId`/`InstanceId` are not read - single-account, non-recurring-meeting compose only.
 * - Attachments present in the composed MIME are relayed correctly (`scanAndRelay()`'s `ScanPipeline` handles
 * the full raw message) but are not additionally persisted as `Attachment` records on the saved Sent Items
 * copy - `Message.hasAttachments` is still set correctly from the parsed MIME, just not each attachment's own
 * row (deferred, matching `ItemOperationsCommand`'s own future `Fetch`-of-Sent-Items scope).
 *
 * `folderClass`/`messageClass` are supplied by the Mongo/SQL concrete subclasses, and `markOriginal()` by the
 * `SmartForwardCommand`/`SmartReplyCommand` subclasses (a no-op here, since plain `SendMailCommand` never has a
 * `<Source>` to act on).
 *
 * @author Jean-Philippe Steinmetz
 */
export abstract class ComposeMailCommand implements EasCommandHandler {
    public abstract readonly command: string;

    protected abstract folderClass: any;
    protected abstract messageClass: any;

    // Automatically injected by ObjectFactory on instantiation
    private _objectFactory?: ObjectFactory;

    protected folderRepo?: RecoverableRepoUtils<any>;
    protected messageRepo?: RecoverableRepoUtils<any>;

    @Inject("BlobStore")
    private blobStore?: BlobStore;

    @Inject("MailTransport")
    private mailTransport?: any;

    @Inject(ScanPipeline)
    private scanPipeline?: ScanPipeline;

    @Inject(ACLUtils)
    private aclUtils?: ACLUtils;

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
    }

    /** Called once the outgoing message has been sent, only when the request carried a `<Source>` (i.e. this
     * is a `SmartForward`/`SmartReply`, never a plain `SendMail`) - flips the referenced original message's own
     * `Answered`/`Forwarded` flag. A no-op here; overridden by the two subclasses that need it. */
    protected async markOriginal(_ctx: EasCommandContext, _original: Message & { uid: string }): Promise<void> {
        // No-op by default (SendMailCommand never calls this - it never resolves a Source).
    }

    public async handle(ctx: EasCommandContext): Promise<WbxmlElement | undefined> {
        if (!this.folderRepo || !this.messageRepo || !this.blobStore || !this.mailTransport || !this.scanPipeline) {
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
        // the same `Message.uid` this library already exposes as `ServerId` in Sync/FolderSync responses, so
        // no separate lookup table is needed. `SendMail` never carries a `<Source>` at all.
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
        const envelopeFrom: string | undefined = parsed.from?.value[0]?.address;
        const envelopeTo: string[] = [...addressesOf(parsed.to), ...addressesOf(parsed.cc), ...addressesOf(parsed.bcc)];
        if (!envelopeFrom || envelopeTo.length === 0) {
            throw new ApiError(ApiErrors.INVALID_REQUEST, 400, "The composed Mime has no resolvable From/To address.");
        }

        const { sanitizedHtmlBlobKey } = await scanAndRelay(raw, envelopeFrom, envelopeTo, this.scanPipeline, this.mailTransport, this.blobStore);

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
            await this.markOriginal(ctx, original);
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
