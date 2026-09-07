///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import { simpleParser } from "mailparser";
import { ApiError, ObjectDecorators } from "@rapidrest/core";
import { ACLAction, ACLUtils, ApiErrorMessages, ApiErrors, ObjectFactory, RepoUtils } from "@rapidrest/service-core";
import { BlobStore, RecoverableRepoUtils, type Attachment, type Message } from "@rapidmx/restapi";
import { WbxmlCodePage } from "../codec/WbxmlCodePages.js";
import { childText, element, findChild, textElement, type WbxmlElement } from "../codec/WbxmlElement.js";
import type { EasCommandContext, EasCommandHandler } from "../EasCommandHandler.js";
const { Init, Inject } = ObjectDecorators;

/**
 * Handles EAS `ItemOperations` `Fetch` - retrieves a `Message`'s full body or an `Attachment`'s binary content
 * by the same `ServerId`/uid this library already exposes elsewhere (Sync's `ServerId`, or an
 * `AirSyncBase:FileReference` set to an `Attachment.uid`), reusing the identical `BlobStore` read path
 * `BaseAttachmentRoute.download()` already uses.
 *
 * **Pragmatic subset, deliberately not the full MS-ASCMD `ItemOperations` semantics**:
 * - Exactly one `<Fetch>` per request is honored, matching this library's single-`Collection`-per-request
 * scope elsewhere (`SyncCommand`/`MeetingResponseCommand`).
 * - No `Options` (byte-range, `Schema`, `BodyPreference`) support - always returns the complete content.
 * - Only the "inline" delivery method is used (content embedded directly in the WBXML response) - the real
 * spec's "multipart" alternative (WBXML as one part, binary content as a separate part) is not implemented;
 * every attachment this library's own `ScanPipeline` already accepts is assumed to fit comfortably in memory
 * for one response, the same assumption `BaseAttachmentRoute.download()` already makes.
 * - `EmptyFolderContents`/`Move`/document-library `LinkId` fetches are not implemented.
 *
 * `folderClass`/`messageClass`/`attachmentClass` are supplied by the Mongo/SQL concrete subclasses.
 *
 * @author Jean-Philippe Steinmetz
 */
export abstract class ItemOperationsCommand implements EasCommandHandler {
    public readonly command = "ItemOperations";

    protected abstract messageClass: any;
    protected abstract attachmentClass: any;

    // Automatically injected by ObjectFactory on instantiation
    private _objectFactory?: ObjectFactory;

    private messageRepo?: RecoverableRepoUtils<any>;
    private attachmentRepo?: RepoUtils<any>;

    @Inject("BlobStore")
    private blobStore?: BlobStore;

    @Inject(ACLUtils)
    private aclUtils?: ACLUtils;

    @Init
    public async init(): Promise<void> {
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
        if (!this.messageRepo || !this.attachmentRepo || !this.blobStore) {
            throw new ApiError(ApiErrors.INTERNAL_ERROR, 500, ApiErrorMessages.INTERNAL_ERROR);
        }
        const fetchEl = ctx.request ? findChild(ctx.request, "Fetch") : undefined;
        if (!fetchEl) {
            throw new ApiError(ApiErrors.INVALID_REQUEST, 400, ApiErrorMessages.INVALID_REQUEST);
        }

        const fileReference: string | undefined = childText(fetchEl, "FileReference");
        const serverId: string | undefined = childText(fetchEl, "ServerId");

        const fetchResponse: WbxmlElement = fileReference
            ? await this.fetchAttachment(ctx, fileReference)
            : await this.fetchMessage(ctx, serverId);

        return element(WbxmlCodePage.ItemOperations, "ItemOperations", [
            textElement(WbxmlCodePage.ItemOperations, "Status", "1"),
            element(WbxmlCodePage.ItemOperations, "Response", [fetchResponse]),
        ]);
    }

    private async fetchMessage(ctx: EasCommandContext, serverId: string | undefined): Promise<WbxmlElement> {
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

        // Prefer the already-sanitized HTML body (script/active-content stripped by ScanPipeline at
        // ingestion/send time) over re-deriving anything from the raw MIME - the same preference
        // `Message.sanitizedHtmlBlobKey`'s own doc comment describes for any renderer.
        let bodyType = "1";
        let bodyText: string;
        if (message.sanitizedHtmlBlobKey) {
            bodyType = "2";
            bodyText = (await this.blobStore!.get(message.sanitizedHtmlBlobKey)).toString("utf-8");
        } else {
            const raw = await this.blobStore!.get(message.bodyBlobKey);
            const parsed = await simpleParser(raw);
            bodyText = parsed.text ?? "";
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
                    textElement(WbxmlCodePage.AirSyncBase, "Truncated", "0"),
                    textElement(WbxmlCodePage.AirSyncBase, "Data", bodyText),
                ]),
            ]),
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
