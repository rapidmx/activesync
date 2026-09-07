///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
// ProvisionCommand has no DI dependencies of its own (no @Config/@Init), so its edge-case branches are tested
// directly against a hand-built EasCommandContext rather than through a full HTTP+DB server harness. The real
// two-phase handshake (issue -> acknowledge, including the mismatched-key rejection) is already covered end to
// end in test/routes/{mongo,sql}/EasRoute.test.ts; this file covers only the malformed/absent-request shapes
// those real-flow tests never produce (a real EAS client always sends a well-formed Policies/Policy body).
import { ProvisionCommand } from "../../src/commands/ProvisionCommand.js";
import { childText, findChild } from "../../src/codec/WbxmlElement.js";
import type { EasCommandContext } from "../../src/EasCommandHandler.js";

function makeContext(overrides: Partial<EasCommandContext> = {}): EasCommandContext {
    return {
        user: { uid: "user-1", roles: [], scopes: [] },
        mailboxUid: "mbx-1",
        deviceId: "dev-1",
        deviceType: "TestPhone",
        deviceSyncState: { uid: "dss-1", version: 1, policyKey: undefined, provisioned: false } as any,
        deviceSyncStateRepo: { update: vi.fn().mockResolvedValue(undefined) } as any,
        query: {},
        request: undefined,
        req: {} as any,
        ...overrides,
    };
}

describe("ProvisionCommand Tests", () => {
    it("Issues a new policy using the default policy type when the request body is absent entirely.", async () => {
        const command = new ProvisionCommand();
        const ctx = makeContext({ request: undefined });

        const response = await command.handle(ctx);

        expect(childText(response!, "Status")).toBe("1");
        const policy = findChild(findChild(response!, "Policies")!, "Policy")!;
        expect(childText(policy, "PolicyType")).toBe("MS-EAS-Provisioning-WBXML");
        expect(childText(policy, "PolicyKey")).toBeTruthy();
        expect(ctx.deviceSyncState.provisioned).toBe(false);
    });
});
