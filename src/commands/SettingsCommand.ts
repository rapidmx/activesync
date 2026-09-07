///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import { ApiError, ObjectDecorators } from "@rapidrest/core";
import { ApiErrorMessages, ApiErrors, ObjectFactory, RepoUtils } from "@rapidrest/service-core";
import { WbxmlCodePage } from "../codec/WbxmlCodePages.js";
import { element, findChild, textElement, type WbxmlElement } from "../codec/WbxmlElement.js";
import type { EasCommandContext, EasCommandHandler } from "../EasCommandHandler.js";
import type { Mailbox } from "@rapidmx/restapi";
const { Init } = ObjectDecorators;

/**
 * Handles EAS `Settings`: the first-run/general-purpose device<->server settings exchange. This pragmatic
 * subset supports only the two sub-elements every real client actually depends on to finish account setup:
 *
 * - `UserInformation`/`Get`: returns the mailbox's `primarySmtpAddress`/`aliasAddresses` as `EmailAddresses`.
 * - `DeviceInformation`/`Set`: acknowledged with `Status 1` but not persisted anywhere - `DeviceSyncState` has
 * no fields for a device's model/IMEI/OS/friendly name, and nothing else in this library currently consumes
 * them. A real client only requires the acknowledgement to proceed past first-run setup, not that the values
 * are retrievable later.
 * - `Oof` (out-of-office) and `RightsManagementInformation` are not implemented - deferred, matching this
 * library's "pragmatic subset" precedent elsewhere (e.g. `ComposeMailCommand`'s own documented gaps).
 *
 * `mailboxClass` is supplied by the Mongo/SQL concrete subclasses.
 *
 * @author Jean-Philippe Steinmetz
 */
export abstract class SettingsCommand implements EasCommandHandler {
    public readonly command = "Settings";

    protected abstract mailboxClass: any;

    // Automatically injected by ObjectFactory on instantiation
    private _objectFactory?: ObjectFactory;

    private mailboxRepo?: RepoUtils<any>;

    @Init
    public async init(): Promise<void> {
        this.mailboxRepo = await this._objectFactory!.newInstance(RepoUtils, {
            name: this.mailboxClass.name,
            args: [this.mailboxClass],
        });
    }

    public async handle(ctx: EasCommandContext): Promise<WbxmlElement | undefined> {
        if (!this.mailboxRepo) {
            throw new ApiError(ApiErrors.INTERNAL_ERROR, 500, ApiErrorMessages.INTERNAL_ERROR);
        }

        const children: WbxmlElement[] = [textElement(WbxmlCodePage.Settings, "Status", "1")];

        if (ctx.request && findChild(ctx.request, "DeviceInformation")) {
            children.push(
                element(WbxmlCodePage.Settings, "DeviceInformation", [textElement(WbxmlCodePage.Settings, "Status", "1")]),
            );
        }

        if (ctx.request && findChild(ctx.request, "UserInformation")) {
            const mailbox: Mailbox | undefined = await this.mailboxRepo.findOne(ctx.mailboxUid, { ignoreACL: true });
            if (!mailbox) {
                throw new ApiError(ApiErrors.NOT_FOUND, 404, ApiErrorMessages.NOT_FOUND);
            }
            children.push(
                element(WbxmlCodePage.Settings, "UserInformation", [
                    textElement(WbxmlCodePage.Settings, "Status", "1"),
                    element(WbxmlCodePage.Settings, "EmailAddresses", [
                        textElement(WbxmlCodePage.Settings, "SmtpAddress", mailbox.primarySmtpAddress),
                        ...mailbox.aliasAddresses.map((address) => textElement(WbxmlCodePage.Settings, "SmtpAddress", address)),
                    ]),
                ]),
            );
        }

        return element(WbxmlCodePage.Settings, "Settings", children);
    }
}
