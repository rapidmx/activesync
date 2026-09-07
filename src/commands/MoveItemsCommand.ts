///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import { ObjectDecorators } from "@rapidrest/core";
import { ACLAction, ACLUtils, ObjectFactory, RepoUtils } from "@rapidrest/service-core";
import type { Folder, Message } from "@rapidmx/restapi";
import { WbxmlCodePage } from "../codec/WbxmlCodePages.js";
import { childText, element, findChildren, textElement, type WbxmlElement } from "../codec/WbxmlElement.js";
import type { EasCommandContext, EasCommandHandler } from "../EasCommandHandler.js";
const { Init, Inject } = ObjectDecorators;

/** [MS-ASCMD] `Move` `Status` codes this pragmatic subset actually distinguishes: `1` success, everything else
 * collapses to `3` ("failure") - an approximation, not a byte-exact enumeration of every real status code
 * MS-ASCMD's `Move` page defines, matching `ProvisionCommand`'s own identical precedent for the same reasoning
 * (this library only needs to tell a client "it worked" from "it didn't, don't retry blindly"). */
const STATUS_SUCCESS = "1";
const STATUS_FAILURE = "3";

/**
 * Handles the standalone EAS `MoveItems` command: moves one or more `Message`s between folders in the caller's
 * own mailbox by `ServerId`/`uid`.
 *
 * **Pragmatic subset**: `Message` only - `Contacts`/`Calendar`/`Tasks` moves are rare in practice (unlike
 * `Message`, whose Inbox-to-subfolder filing is a real, common client action) and would each need their own
 * ACL/ownership verification path for comparatively little value; a client attempting one gets `Status 3`
 * rather than being silently ignored. `DstMsgId` in the response is always the same `uid` as `SrcMsgId` - this
 * library never mints a new identifier on move, unlike a real Exchange server, which sometimes does.
 *
 * `messageClass`/`folderClass` are supplied by the Mongo/SQL concrete subclasses.
 *
 * @author Jean-Philippe Steinmetz
 */
export abstract class MoveItemsCommand implements EasCommandHandler {
    public readonly command = "MoveItems";

    protected abstract messageClass: any;
    protected abstract folderClass: any;

    // Automatically injected by ObjectFactory on instantiation
    private _objectFactory?: ObjectFactory;

    private messageRepo?: RepoUtils<any>;
    private folderRepo?: RepoUtils<any>;

    @Inject(ACLUtils)
    private aclUtils?: ACLUtils;

    @Init
    public async init(): Promise<void> {
        this.messageRepo = await this._objectFactory!.newInstance(RepoUtils, {
            name: this.messageClass.name,
            args: [this.messageClass],
        });
        this.folderRepo = await this._objectFactory!.newInstance(RepoUtils, {
            name: this.folderClass.name,
            args: [this.folderClass],
        });
    }

    public async handle(ctx: EasCommandContext): Promise<WbxmlElement | undefined> {
        const moveEls = ctx.request ? findChildren(ctx.request, "Move") : [];
        const responses: WbxmlElement[] = [];
        for (const moveEl of moveEls) {
            responses.push(await this.moveOne(ctx, moveEl));
        }
        return element(WbxmlCodePage.Move, "MoveItems", responses);
    }

    private async moveOne(ctx: EasCommandContext, moveEl: WbxmlElement): Promise<WbxmlElement> {
        const srcMsgId = childText(moveEl, "SrcMsgId");
        const srcFldId = childText(moveEl, "SrcFldId");
        const dstFldId = childText(moveEl, "DstFldId");
        if (!srcMsgId || !srcFldId || !dstFldId) {
            return this.responseElement(srcMsgId, STATUS_FAILURE, undefined);
        }

        const message: Message | undefined = await this.messageRepo!.findOne(srcMsgId, { ignoreACL: true });
        // The client's claimed SrcFldId must match where the message actually lives - protects against a
        // stale/mismatched client cache rather than trusting the claim outright.
        if (!message || message.folderUid !== srcFldId) {
            return this.responseElement(srcMsgId, STATUS_FAILURE, undefined);
        }
        if (
            !(await this.aclUtils!.hasPermission(ctx.user, srcFldId, ACLAction.UPDATE)) ||
            !(await this.aclUtils!.hasPermission(ctx.user, dstFldId, ACLAction.CREATE))
        ) {
            return this.responseElement(srcMsgId, STATUS_FAILURE, undefined);
        }

        const destFolder: Folder | undefined = await this.folderRepo!.findOne(dstFldId, { ignoreACL: true });
        if (!destFolder || destFolder.mailboxUid !== ctx.mailboxUid) {
            return this.responseElement(srcMsgId, STATUS_FAILURE, undefined);
        }

        await this.messageRepo!.update(
            { uid: message.uid, version: (message as any).version, folderUid: dstFldId } as any,
            message,
            { ignoreACL: true, user: ctx.user },
        );

        return this.responseElement(srcMsgId, STATUS_SUCCESS, message.uid);
    }

    private responseElement(srcMsgId: string | undefined, status: string, dstMsgId: string | undefined): WbxmlElement {
        return element(WbxmlCodePage.Move, "Response", [
            ...(srcMsgId ? [textElement(WbxmlCodePage.Move, "SrcMsgId", srcMsgId)] : []),
            textElement(WbxmlCodePage.Move, "Status", status),
            ...(dstMsgId ? [textElement(WbxmlCodePage.Move, "DstMsgId", dstMsgId)] : []),
        ]);
    }
}
