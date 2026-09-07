///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
// Isolated unit tests for BaseEasRoute, reserved for the defensive guard branches a real wired server can
// never exercise (`!this.deviceSyncStateRepo || !this.mailboxRepo` - DI always populates both before a request
// can reach a route - and `!user`, a second defensive check behind `@Auth(["jwt"])` itself for the rare case
// `dispatch()` is invoked directly, same rationale `BaseFolderRoute.test.ts`/`BaseMessageRoute.test.ts` already
// use for their own guard clauses), plus the "handler legitimately returns no body" response path - no
// currently-registered real command (Provision/FolderSync/Ping) ever takes that branch, so it's exercised here
// against a hand-registered fake handler rather than left uncovered. Every other behavior (query-parameter
// validation, mailbox resolution, DeviceSyncState find-or-create, the provisioning gate, unimplemented-command
// handling) is exercised via real HTTP+DB requests in test/routes/mongo/EasRoute.test.ts (and its sql/
// counterpart), matching this library's real-server-integration-test convention.
//
// `options()` is also tested directly here (a direct method call, not real HTTP) rather than via those
// integration tests: it only actually bypasses the global CORS preflight 204 on a `@rapidrest/service-core`
// version carrying this session's own `hasExplicitOptionsRoute()` fix, which this package's currently-pinned
// published `service-core` dependency doesn't yet include - see `BaseEasRoute.ts`'s own doc comment. A direct
// call proves the handler's own header-building logic is correct regardless of that upstream dependency.
import config from "../config.js";
import { ObjectFactory } from "@rapidrest/service-core";
import { Logger } from "@rapidrest/core";
import { BaseEasRoute } from "../../src/BaseEasRoute.js";

class TestEasRoute extends BaseEasRoute<any> {
    protected deviceSyncStateClass: any = { name: "TestDeviceSyncState" };
    protected mailboxClass: any = { name: "TestMailbox" };
}

function makeReq(): any {
    return { query: { Cmd: "FolderSync", DeviceId: "dev1" }, rawBody: undefined };
}

function makeRes(): any {
    return {
        status: vi.fn().mockReturnThis(),
        setHeader: vi.fn().mockReturnThis(),
        send: vi.fn().mockReturnThis(),
    };
}

describe("BaseEasRoute Tests (guard clauses only)", () => {
    const objectFactory: ObjectFactory = new ObjectFactory(config, Logger());

    afterEach(() => {
        vi.restoreAllMocks();
    });

    it("dispatch() throws INTERNAL_ERROR when deviceSyncStateRepo/mailboxRepo are not set.", async () => {
        // `initialize: false` skips `@Init` (and `@Config`/`@Logger`/`@Inject`), leaving both repos
        // genuinely `undefined` - exactly what this guard clause exists to catch.
        const route = objectFactory.newInstance<TestEasRoute>(TestEasRoute, { initialize: false });

        await expect(route.dispatch(makeReq(), makeRes(), { uid: "user-1" } as any)).rejects.toThrow(
            /internal error/i,
        );
    });

    it("dispatch() throws AUTH_PERMISSION_FAILURE when no authenticated user is present.", async () => {
        const route = objectFactory.newInstance<TestEasRoute>(TestEasRoute, { initialize: false });
        // Poking the private repo fields directly (TypeScript `private` is compile-time only) isolates this
        // guard from the one above, which would otherwise fire first.
        (route as any).deviceSyncStateRepo = {};
        (route as any).mailboxRepo = {};

        await expect(route.dispatch(makeReq(), makeRes(), undefined)).rejects.toThrow(/permission/i);
    });

    it("dispatch() sends a bare 200 with no body when the matched handler returns undefined.", async () => {
        const route = objectFactory.newInstance<TestEasRoute>(TestEasRoute, { initialize: false });
        const deviceSyncState = { uid: "dss-1", version: 1, provisioned: true, mailboxUid: "mbx-1", deviceId: "dev1" };
        (route as any).deviceSyncStateRepo = {
            find: vi.fn().mockResolvedValue([deviceSyncState]),
            update: vi.fn().mockResolvedValue(undefined),
        };
        (route as any).mailboxRepo = { find: vi.fn().mockResolvedValue([{ uid: "mbx-1" }]) };
        (route as any).handlers.set("NoOp", { command: "NoOp", handle: vi.fn().mockResolvedValue(undefined) });

        const res = makeRes();
        await route.dispatch({ query: { Cmd: "NoOp", DeviceId: "dev1" }, rawBody: undefined } as any, res, {
            uid: "user-1",
        } as any);

        expect(res.status).toHaveBeenCalledWith(200);
        expect(res.send).toHaveBeenCalledWith();
    });

    it("options() answers with MS-ASProtocolVersions/MS-ASProtocolCommands derived from the registered handlers.", async () => {
        const route = objectFactory.newInstance<TestEasRoute>(TestEasRoute, { initialize: false });
        (route as any).handlers.set("FolderSync", { command: "FolderSync" });
        (route as any).handlers.set("Sync", { command: "Sync" });

        const res = makeRes();
        await route.options(res);

        expect(res.setHeader).toHaveBeenCalledWith("MS-ASProtocolVersions", "14.0,14.1");
        expect(res.setHeader).toHaveBeenCalledWith("MS-ASProtocolCommands", "FolderSync,Sync");
        expect(res.status).toHaveBeenCalledWith(200);
        expect(res.send).toHaveBeenCalledWith();
    });
});
