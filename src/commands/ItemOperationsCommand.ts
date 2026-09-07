///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import { simpleParser } from "mailparser";
import { ApiError, ObjectDecorators } from "@rapidrest/core";
import { ACLAction, ACLUtils, ApiErrorMessages, ApiErrors, ObjectFactory, RepoUtils } from "@rapidrest/service-core";
import { BlobStore, RecoverableRepoUtils, type Attachment, type Message } from "@rapidmx/restapi";
import { WbxmlCodePage } from "../codec/WbxmlCodePages.js";
import { childText, element, findChild, findChildren, textElement, type WbxmlElement } from "../codec/WbxmlElement.js";
import type { EasCommandContext, EasCommandHandler } from "../EasCommandHandler.js";
const { Init, Inject } = ObjectDecorators;

/** Truncates UTF-8 text to at most `maxBytes` bytes without splitting a multi-byte character in half - backs
 * off past any trailing UTF-8 continuation byte (`10xxxxxx`) before decoding back to a string. Only ever
 * called once the caller has already confirmed the text exceeds `maxBytes` - trusts that rather than
 * re-checking it here. */
function truncateUtf8(text: string, maxBytes: number): string {
    const buf = Buffer.from(text, "utf8");
    let end = maxBytes;
    while (end > 0 && (buf[end] & 0xc0) === 0x80) {
        end--;
    }
    return buf.subarray(0, end).toString("utf8");
}

/**
 * Handles EAS `ItemOperations`: `Fetch` (a `Message`'s full body or an `Attachment`'s binary content, by the
 * same `ServerId`/uid this library already exposes elsewhere) and `EmptyFolderContents`.
 *
 * Per the published [MS-ASCMD] `ItemOperations` request schema (confirmed directly, not assumed), the command
 * is a strict choice of exactly three operations - `Fetch` (unbounded), `EmptyFolderContents`, and `Move` -
 * with no fourth "write a new item" capability anywhere in it; `Store` is a required *child* of `Fetch`
 * (`"Mailbox"` or `"DocumentLibrary"`, the same store-selector role it plays in `SearchCommand`), not a
 * separate write/upload command as its name might suggest.
 *
 * **Pragmatic subset, deliberately not the full MS-ASCMD `ItemOperations` semantics**:
 * - `Move` (which, per the same schema, moves an entire *conversation* by `ConversationId` to a destination
 * folder - unrelated to the standalone `MoveItems` command's per-message `SrcFldId`/`SrcMsgId`/`DstFldId`
 * shape) is not implemented - this library has no conversation-grouping concept for `Message` at all. A
 * request containing only a `Move` (no `Fetch`/`EmptyFolderContents`) is rejected the same way a request with
 * no recognized operation at all is.
 * - `Store: "DocumentLibrary"` is rejected per-`Fetch` - matches `SearchCommand`'s own GAL-only scope decision;
 * this library has no document-library model.
 * - A `Fetch` failure (not found, no permission, malformed) aborts the whole request via an HTTP-level error
 * rather than an embedded per-`Fetch` `Status` code the way `Sync`/`MoveItems`/`ResolveRecipients` report
 * their own per-item failures - a deliberate, documented simplification carried over unchanged from this
 * command's original single-`Fetch` design, not a new gap introduced by adding multi-`Fetch` support.
 * - Only the "inline" delivery method is used (content embedded directly in the WBXML response) - the real
 * spec's "multipart" alternative (WBXML as one part, binary content as a separate part) is not implemented;
 * every attachment this library's own `ScanPipeline` already accepts is assumed to fit comfortably in memory
 * for one response, the same assumption `BaseAttachmentRoute.download()` already makes.
 * - `Options/BodyPreference`'s `Type`/`TruncationSize` are honored for a `Message` body fetch (plain text,
 * HTML, or - `Type 4` - the raw MIME source verbatim); byte-range fetching (`Range`) is not implemented.
 * - `EmptyFolderContents`'s `DeleteSubFolders` option is rejected outright rather than silently ignored -
 * recursive subfolder deletion is out of scope for this pragmatic subset; emptying a single folder's own
 * `Message`s is the common case this implements.
 *
 * `folderClass`/`messageClass`/`attachmentClass` are supplied by the Mongo/SQL concrete subclasses.
 *
 * @author Jean-Philippe Steinmetz
 */
export abstract class ItemOperationsCommand implements EasCommandHandler {
    public readonly command = "ItemOperations";

    protected abstract folderClass: any;
    protected abstract messageClass: any;
    protected abstract attachmentClass: any;

    // Automatically injected by ObjectFactory on instantiation
    private _objectFactory?: ObjectFactory;

    private folderRepo?: RepoUtils<any>;
    private messageRepo?: RecoverableRepoUtils<any>;
    private attachmentRepo?: RepoUtils<any>;

    @Inject("BlobStore")
    private blobStore?: BlobStore;

    @Inject(ACLUtils)
    private aclUtils?: ACLUtils;

    @Init
    public async init(): Promise<void> {
        this.folderRepo = await this._objectFactory!.newInstance(RepoUtils, {
            name: this.folderClass.name,
            args: [this.folderClass],
        });
        this.messageRepo = await this._objectFactory!.newInstance(RecoverableRepoUtils, {
            name: this.messageClass.name,
            args: [this.messageClass],
        });
        this.attachmentRepo = await this._objectFactory!.newInstance(RepoUtils, {
            name: this.attachmentClass.name,
            args: [this.attachmentClass],
        });
    }

    public async handle(ctx: EasCommandContext): Promise<WbxmlElement | undefined> {
        if (!this.folderRepo || !this.messageRepo || !this.attachmentRepo || !this.blobStore) {
            throw new ApiError(ApiErrors.INTERNAL_ERROR, 500, ApiErrorMessages.INTERNAL_ERROR);
        }
        const fetchEls = ctx.request ? findChildren(ctx.request, "Fetch") : [];
        const emptyEl = ctx.request ? findChild(ctx.request, "EmptyFolderContents") : undefined;
        if (fetchEls.length === 0 && !emptyEl) {
            // Covers both a genuinely empty request and one containing only a `Move` - see this class's own
            // doc comment for why conversation `Move` isn't implemented.
            throw new ApiError(ApiErrors.INVALID_REQUEST, 400, ApiErrorMessages.INVALID_REQUEST);
        }

        const responseChildren: WbxmlElement[] = [];
        for (const fetchEl of fetchEls) {
            const store = childText(fetchEl, "Store");
            if (store === "DocumentLibrary") {
                throw new ApiError(ApiErrors.INVALID_REQUEST, 400, "DocumentLibrary fetches are not supported.");
            }
            const fileReference: string | undefined = childText(fetchEl, "FileReference");
            const serverId: string | undefined = childText(fetchEl, "ServerId");
            const optionsEl = findChild(fetchEl, "Options");
            responseChildren.push(
                fileReference
                    ? await this.fetchAttachment(ctx, fileReference)
                    : await this.fetchMessage(ctx, serverId, optionsEl),
            );
        }
        if (emptyEl) {
            responseChildren.push(await this.emptyFolderContents(ctx, emptyEl));
        }

        return element(WbxmlCodePage.ItemOperations, "ItemOperations", [
            textElement(WbxmlCodePage.ItemOperations, "Status", "1"),
            element(WbxmlCodePage.ItemOperations, "Response", responseChildren),
        ]);
    }

    private async fetchMessage(
        ctx: EasCommandContext,
        serverId: string | undefined,
        optionsEl: WbxmlElement | undefined,
    ): Promise<WbxmlElement> {
        if (!serverId) {
            throw new ApiError(ApiErrors.INVALID_REQUEST, 400, "Fetch requires either a ServerId or a FileReference.");
        }
        const message: Message | undefined = await this.messageRepo!.findOne(serverId, { ignoreACL: true });
        if (!message) {
            throw new ApiError(ApiErrors.NOT_FOUND, 404, ApiErrorMessages.NOT_FOUND);
        }
        if (!(await this.aclUtils!.hasPermission(ctx.user, message.folderUid, ACLAction.READ))) {
            throw new ApiError(ApiErrors.AUTH_PERMISSION_FAILURE, 403, ApiErrorMessages.AUTH_PERMISSION_FAILURE);
        }

        const bodyPreferenceEl = optionsEl ? findChild(optionsEl, "BodyPreference") : undefined;
        const requestedType = bodyPreferenceEl ? childText(bodyPreferenceEl, "Type") : undefined;
        const truncationSizeText = bodyPreferenceEl ? childText(bodyPreferenceEl, "TruncationSize") : undefined;
        const truncationSize = truncationSizeText !== undefined ? Number(truncationSizeText) : undefined;

        // Prefer the already-sanitized HTML body (script/active-content stripped by ScanPipeline at
        // ingestion/send time) over re-deriving anything from the raw MIME - the same preference
        // `Message.sanitizedHtmlBlobKey`'s own doc comment describes for any renderer. `Type 4` (MIME) is an
        // explicit client request for the verbatim raw source instead, honored regardless of that preference.
        let bodyType = "1";
        let bodyText: string;
        if (requestedType === "4") {
            bodyType = "4";
            bodyText = (await this.blobStore!.get(message.bodyBlobKey)).toString("utf-8");
        } else if (message.sanitizedHtmlBlobKey) {
            bodyType = "2";
            bodyText = (await this.blobStore!.get(message.sanitizedHtmlBlobKey)).toString("utf-8");
        } else {
            const raw = await this.blobStore!.get(message.bodyBlobKey);
            const parsed = await simpleParser(raw);
            bodyText = parsed.text ?? "";
        }

        let truncated = false;
        if (truncationSize !== undefined && Number.isFinite(truncationSize) && Buffer.byteLength(bodyText, "utf8") > truncationSize) {
            bodyText = truncateUtf8(bodyText, truncationSize);
            truncated = true;
        }

        return element(WbxmlCodePage.ItemOperations, "Fetch", [
            textElement(WbxmlCodePage.ItemOperations, "Status", "1"),
            textElement(WbxmlCodePage.AirSync, "Class", "Email"),
            textElement(WbxmlCodePage.AirSync, "CollectionId", message.folderUid),
            textElement(WbxmlCodePage.AirSync, "ServerId", serverId),
            element(WbxmlCodePage.ItemOperations, "Properties", [
                element(WbxmlCodePage.AirSyncBase, "Body", [
                    textElement(WbxmlCodePage.AirSyncBase, "Type", bodyType),
                    textElement(WbxmlCodePage.AirSyncBase, "EstimatedDataSize", String(Buffer.byteLength(bodyText, "utf8"))),
                    textElement(WbxmlCodePage.AirSyncBase, "Truncated", truncated ? "1" : "0"),
                    textElement(WbxmlCodePage.AirSyncBase, "Data", bodyText),
                ]),
            ]),
        ]);
    }

    private async emptyFolderContents(ctx: EasCommandContext, emptyEl: WbxmlElement): Promise<WbxmlElement> {
        // Reuses AirSync's own `CollectionId` (the same tag `Sync`/`Fetch` responses already reference a
        // folder by) rather than a page-specific tag - `WbxmlCodePage.ItemOperations` has no `FolderId` token
        // of its own at all, confirmed against its own tag table.
        const folderUid = childText(emptyEl, "CollectionId");
        if (!folderUid) {
            throw new ApiError(ApiErrors.INVALID_REQUEST, 400, "EmptyFolderContents requires a CollectionId.");
        }
        const optionsEl = findChild(emptyEl, "Options");
        if (optionsEl && findChild(optionsEl, "DeleteSubFolders")) {
            // Documented gap, not silently ignored - see this class's own doc comment.
            throw new ApiError(ApiErrors.INVALID_REQUEST, 400, "DeleteSubFolders is not supported.");
        }
        if (!(await this.aclUtils!.hasPermission(ctx.user, folderUid, ACLAction.DELETE))) {
            throw new ApiError(ApiErrors.AUTH_PERMISSION_FAILURE, 403, ApiErrorMessages.AUTH_PERMISSION_FAILURE);
        }

        const messages = await this.messageRepo!.find({ folderUid } as any, { ignoreACL: true });
        for (const message of messages) {
            await this.messageRepo!.delete(message.uid, { ignoreACL: true, user: ctx.user });
        }

        return element(WbxmlCodePage.ItemOperations, "EmptyFolderContents", [
            textElement(WbxmlCodePage.ItemOperations, "Status", "1"),
        ]);
    }

    private async fetchAttachment(ctx: EasCommandContext, fileReference: string): Promise<WbxmlElement> {
        const attachment: Attachment | undefined = await this.attachmentRepo!.findOne(fileReference, { ignoreACL: true });
        if (!attachment) {
            throw new ApiError(ApiErrors.NOT_FOUND, 404, ApiErrorMessages.NOT_FOUND);
        }
        if (!(await this.aclUtils!.hasPermission(ctx.user, attachment.folderUid, ACLAction.READ))) {
            throw new ApiError(ApiErrors.AUTH_PERMISSION_FAILURE, 403, ApiErrorMessages.AUTH_PERMISSION_FAILURE);
        }

        const content = await this.blobStore!.get(attachment.blobKey);

        return element(WbxmlCodePage.ItemOperations, "Fetch", [
            textElement(WbxmlCodePage.ItemOperations, "Status", "1"),
            textElement(WbxmlCodePage.AirSyncBase, "FileReference", fileReference),
            element(WbxmlCodePage.ItemOperations, "Properties", [
                textElement(WbxmlCodePage.AirSyncBase, "ContentType", attachment.mimeType),
                // "Inline" delivery per MS-ASCMD: binary content is base64-encoded and embedded directly in the
                // WBXML, rather than this library's own opaque/binary element type.
                textElement(WbxmlCodePage.ItemOperations, "Data", content.toString("base64")),
            ]),
        ]);
    }
}
