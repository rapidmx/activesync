///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import * as crypto from "crypto";
import { WbxmlCodePage } from "../codec/WbxmlCodePages.js";
import { childText, element, findChild, textElement, type WbxmlElement } from "../codec/WbxmlElement.js";
import type { EasCommandContext, EasCommandHandler } from "../EasCommandHandler.js";

const DEFAULT_POLICY_TYPE = "MS-EAS-Provisioning-WBXML";

/**
 * Handles the two-request EAS `Provision` handshake (MS-ASPROV) every client must complete before any other
 * command is honored (see `BaseEasRoute`'s provisioning gate). No real MDM policy enforcement is implemented —
 * matching this library's pragmatic-subset scope elsewhere — the policy document sent back on the first
 * request is deliberately permissive (no password/encryption requirements); this handler's only real job is
 * running the handshake itself and flipping `DeviceSyncState.provisioned`.
 *
 * - **Request 1** (no `PolicyKey` in the body): mint a new policy key, store it on `DeviceSyncState` (not yet
 * provisioned), and send back the policy document under that key.
 * - **Request 2** (client echoes the `PolicyKey` back, acknowledging the policy): if it matches what was
 * minted in request 1, mark the device provisioned and re-confirm the same key; a mismatch (a stale/replayed
 * key, or a device that never actually saw request 1's response) is rejected without provisioning.
 *
 * @author Jean-Philippe Steinmetz
 */
export class ProvisionCommand implements EasCommandHandler {
    public readonly command = "Provision";

    public async handle(ctx: EasCommandContext): Promise<WbxmlElement | undefined> {
        const policiesEl = ctx.request ? findChild(ctx.request, "Policies") : undefined;
        const policyEl = policiesEl ? findChild(policiesEl, "Policy") : undefined;
        const policyType: string = (policyEl ? childText(policyEl, "PolicyType") : undefined) ?? DEFAULT_POLICY_TYPE;
        const clientPolicyKey: string | undefined = policyEl ? childText(policyEl, "PolicyKey") : undefined;

        if (!clientPolicyKey) {
            return await this.issuePolicy(ctx, policyType);
        }
        return await this.acknowledgePolicy(ctx, policyType, clientPolicyKey);
    }

    /** Request 1: mint and store a new policy key, send the (permissive) policy document. */
    private async issuePolicy(ctx: EasCommandContext, policyType: string): Promise<WbxmlElement> {
        const policyKey: string = crypto.randomBytes(8).toString("hex");
        await this.persist(ctx, { policyKey, provisioned: false });

        return element(WbxmlCodePage.Provision, "Provision", [
            textElement(WbxmlCodePage.Provision, "Status", "1"),
            element(WbxmlCodePage.Provision, "Policies", [
                element(WbxmlCodePage.Provision, "Policy", [
                    textElement(WbxmlCodePage.Provision, "PolicyType", policyType),
                    textElement(WbxmlCodePage.Provision, "Status", "1"),
                    textElement(WbxmlCodePage.Provision, "PolicyKey", policyKey),
                    element(WbxmlCodePage.Provision, "Data", [
                        element(WbxmlCodePage.Provision, "EASProvisionDoc", [
                            textElement(WbxmlCodePage.Provision, "DevicePasswordEnabled", "0"),
                            textElement(WbxmlCodePage.Provision, "AttachmentsEnabled", "1"),
                        ]),
                    ]),
                ]),
            ]),
        ]);
    }

    /** Request 2: the client acknowledges the policy key it was handed in request 1. */
    private async acknowledgePolicy(
        ctx: EasCommandContext,
        policyType: string,
        clientPolicyKey: string,
    ): Promise<WbxmlElement> {
        if (clientPolicyKey !== ctx.deviceSyncState.policyKey) {
            // Status 2 ("protocol error" per MS-ASPROV) - an approximation, not a byte-exact enumeration of
            // every real status code MS-ASPROV defines; this pragmatic subset only distinguishes success from
            // "something is wrong, start over" (see this class's own doc comment on scope).
            return element(WbxmlCodePage.Provision, "Provision", [textElement(WbxmlCodePage.Provision, "Status", "2")]);
        }

        await this.persist(ctx, { policyKey: clientPolicyKey, provisioned: true });

        return element(WbxmlCodePage.Provision, "Provision", [
            textElement(WbxmlCodePage.Provision, "Status", "1"),
            element(WbxmlCodePage.Provision, "Policies", [
                element(WbxmlCodePage.Provision, "Policy", [
                    textElement(WbxmlCodePage.Provision, "PolicyType", policyType),
                    textElement(WbxmlCodePage.Provision, "Status", "1"),
                    textElement(WbxmlCodePage.Provision, "PolicyKey", clientPolicyKey),
                ]),
            ]),
        ]);
    }

    private async persist(ctx: EasCommandContext, changes: { policyKey: string; provisioned: boolean }): Promise<void> {
        ctx.deviceSyncState.policyKey = changes.policyKey;
        ctx.deviceSyncState.provisioned = changes.provisioned;
        await ctx.deviceSyncStateRepo.update(
            {
                uid: ctx.deviceSyncState.uid,
                version: (ctx.deviceSyncState as any).version,
                policyKey: changes.policyKey,
                provisioned: changes.provisioned,
            } as any,
            ctx.deviceSyncState,
            { ignoreACL: true, skipPush: true },
        );
    }
}
