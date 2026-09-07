///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
// Isolated unit tests for SyncCommand's own client-originated Add/Change/Delete wiring
// (applyAdd/applyChange/applyDelete, Status 6/7/8 mapping, watermark advancement past this round's own writes).
// A fake repo/adapter double is used rather than a real DB, since the version-conflict (Status 7) and
// malformed-item (Status 6) branches require injecting failures that don't arise naturally from a real,
// single-threaded HTTP request - see each test's own comment. Every other Sync behavior (initial sync, reporting
// server-side changes, real per-collection field mapping, SyncKey handshake/rejection) is exercised via real
// HTTP+DB requests in test/routes/{mongo,sql}/EasRoute.test.ts, matching this project's established split
// between isolated unit tests and full-stack integration tests.
import config from "../config.js";
import { ApiError, Logger } from "@rapidrest/core";
import { ApiErrors, ObjectFactory } from "@rapidrest/service-core";
import { SyncCommandMongo } from "../../src/commands/mongo/SyncCommandMongo.js";
import { element, findChild, childText, textElement, type WbxmlElement } from "../../src/codec/WbxmlElement.js";
import { WbxmlCodePage } from "../../src/codec/WbxmlCodePages.js";
import { formatSyncKey } from "../../src/EasSyncKeyUtils.js";
import type { EasCommandContext } from "../../src/EasCommandHandler.js";
import type { EasCollectionSyncAdapter } from "../../src/adapters/EasCollectionSyncAdapter.js";

const FOLDER_UID = "folder-1";
const OLD_WATERMARK = new Date("2026-01-01T00:00:00.000Z");
const STORED_KEY = formatSyncKey({ generation: 1, watermark: OLD_WATERMARK });

/** A fake adapter that never reports server-side changes of its own - every test here only cares about the
 * client-originated Commands path, not computeChanges()'s own enumeration (already covered elsewhere). */
function fakeAdapter(overrides: Partial<EasCollectionSyncAdapter<any>> = {}): EasCollectionSyncAdapter<any> {
    return {
        collectionClass: "Fake",
        toApplicationData: () => element(WbxmlCodePage.AirSync, "ApplicationData", []),
        ...overrides,
    };
}

/** A fake repo double implementing just the RepoUtils surface SyncCommand actually calls. `find` always
 * resolves empty (no server-side changes to enumerate) so every response below is driven purely by the
 * Commands this test sends. */
function fakeRepo(overrides: Record<string, any> = {}): any {
    return {
        find: vi.fn().mockResolvedValue([]),
        findOne: vi.fn(),
        create: vi.fn(),
        update: vi.fn(),
        delete: vi.fn(),
        ...overrides,
    };
}

function syncRequest(collectionClass: string, commandsChildren: WbxmlElement[]): WbxmlElement {
    return element(WbxmlCodePage.AirSync, "Sync", [
        element(WbxmlCodePage.AirSync, "Collections", [
            element(WbxmlCodePage.AirSync, "Collection", [
                textElement(WbxmlCodePage.AirSync, "Class", collectionClass),
                textElement(WbxmlCodePage.AirSync, "SyncKey", STORED_KEY),
                textElement(WbxmlCodePage.AirSync, "CollectionId", FOLDER_UID),
                element(WbxmlCodePage.AirSync, "Commands", commandsChildren),
            ]),
        ]),
    ]);
}

/** Builds a command instance with `repos`/`adapters` directly poked to the given fakes, bypassing @Init/DI
 * entirely - mirrors MeetingResponseCommand.test.ts's own established pattern for isolating a command's logic
 * from real DI/DB wiring. `mailboxRepo` is a bare fake resolving a minimal `Mailbox` - only exercised by the
 * one test whose adapter implements `newEntityDefaults` (mailbox-dependent defaults). */
async function buildCommand(collectionClass: string, adapter: EasCollectionSyncAdapter<any>, repo: any): Promise<SyncCommandMongo> {
    const objectFactory = new ObjectFactory(config, Logger());
    const command = await objectFactory.newInstance<SyncCommandMongo>(SyncCommandMongo, { initialize: false });
    (command as any).collectionBindings = { [collectionClass]: { entityClass: class {}, adapterClass: class {} } };
    (command as any).repos = new Map([[collectionClass, repo]]);
    (command as any).adapters = new Map([[collectionClass, adapter]]);
    (command as any).mailboxRepo = { findOne: vi.fn().mockResolvedValue({ uid: "mbx-1", primarySmtpAddress: "owner@example.com", displayName: "Owner" }) };
    (command as any).windowSize = 100;
    return command;
}

function buildContext(request: WbxmlElement): { ctx: EasCommandContext; deviceSyncStateUpdate: ReturnType<typeof vi.fn> } {
    const deviceSyncStateUpdate = vi.fn().mockResolvedValue(undefined);
    const ctx = {
        user: { uid: "user-1", roles: [], scopes: [] },
        mailboxUid: "mbx-1",
        deviceId: "dev-1",
        deviceType: "Test",
        deviceSyncState: { uid: "dss-1", version: 1, folderSyncKeys: { [FOLDER_UID]: STORED_KEY } },
        deviceSyncStateRepo: { update: deviceSyncStateUpdate },
        query: {},
        request,
    } as unknown as EasCommandContext;
    return { ctx, deviceSyncStateUpdate };
}

function collection(response: WbxmlElement): WbxmlElement {
    return findChild(findChild(response, "Collections")!, "Collection")!;
}

describe("SyncCommand Tests (client-originated Commands, isolated)", () => {
    describe("Add", () => {
        it("Creates a new item and reports Status 1 with the assigned ServerId.", async () => {
            const created = { uid: "new-uid", dateModified: new Date("2026-01-02T00:00:00.000Z") };
            const repo = fakeRepo({ create: vi.fn().mockResolvedValue(created) });
            const adapter = fakeAdapter({ fromApplicationData: () => ({ title: "New Item" }) });
            const command = await buildCommand("Fake", adapter, repo);
            const request = syncRequest("Fake", [
                element(WbxmlCodePage.AirSync, "Add", [
                    textElement(WbxmlCodePage.AirSync, "ClientId", "client-1"),
                    element(WbxmlCodePage.AirSync, "ApplicationData", []),
                ]),
            ]);
            const { ctx } = buildContext(request);

            const response = await command.handle(ctx);

            const add = findChild(findChild(collection(response!), "Responses")!, "Add")!;
            expect(childText(add, "ClientId")).toBe("client-1");
            expect(childText(add, "ServerId")).toBe("new-uid");
            expect(childText(add, "Status")).toBe("1");
            expect(repo.create).toHaveBeenCalledWith(
                { title: "New Item", mailboxUid: "mbx-1", folderUid: FOLDER_UID },
                { ignoreACL: true },
            );
        });

        it("Merges newEntityDefaults() under the parsed partial, letting an explicit field win.", async () => {
            const created = { uid: "new-uid", dateModified: new Date() };
            const repo = fakeRepo({ create: vi.fn().mockResolvedValue(created) });
            const adapter = fakeAdapter({
                fromApplicationData: () => ({ sequence: 5 }),
                newEntityDefaults: () => ({ icalUid: "generated@eas", sequence: 0 }),
            });
            const command = await buildCommand("Fake", adapter, repo);
            const request = syncRequest("Fake", [
                element(WbxmlCodePage.AirSync, "Add", [element(WbxmlCodePage.AirSync, "ApplicationData", [])]),
            ]);
            const { ctx } = buildContext(request);

            await command.handle(ctx);

            expect(repo.create).toHaveBeenCalledWith(
                { icalUid: "generated@eas", sequence: 5, mailboxUid: "mbx-1", folderUid: FOLDER_UID },
                { ignoreACL: true },
            );
        });

        it("Rejects with Status 6 when the caller's own mailbox has vanished (needed for newEntityDefaults()).", async () => {
            const repo = fakeRepo();
            const adapter = fakeAdapter({
                fromApplicationData: () => ({}),
                newEntityDefaults: () => ({}),
            });
            const command = await buildCommand("Fake", adapter, repo);
            (command as any).mailboxRepo = { findOne: vi.fn().mockResolvedValue(undefined) };
            const request = syncRequest("Fake", [
                element(WbxmlCodePage.AirSync, "Add", [element(WbxmlCodePage.AirSync, "ApplicationData", [])]),
            ]);
            const { ctx } = buildContext(request);

            const response = await command.handle(ctx);

            const add = findChild(findChild(collection(response!), "Responses")!, "Add")!;
            expect(childText(add, "Status")).toBe("6");
            expect(repo.create).not.toHaveBeenCalled();
        });

        it("Rejects with Status 6 when the adapter has no fromApplicationData at all (e.g. Email).", async () => {
            const repo = fakeRepo();
            const adapter = fakeAdapter();
            const command = await buildCommand("Fake", adapter, repo);
            const request = syncRequest("Fake", [
                element(WbxmlCodePage.AirSync, "Add", [
                    textElement(WbxmlCodePage.AirSync, "ClientId", "client-1"),
                    element(WbxmlCodePage.AirSync, "ApplicationData", []),
                ]),
            ]);
            const { ctx } = buildContext(request);

            const response = await command.handle(ctx);

            const add = findChild(findChild(collection(response!), "Responses")!, "Add")!;
            expect(childText(add, "ClientId")).toBe("client-1");
            expect(findChild(add, "ServerId")).toBeUndefined();
            expect(childText(add, "Status")).toBe("6");
            expect(repo.create).not.toHaveBeenCalled();
        });

        it("Rejects with Status 6 when ApplicationData is missing entirely.", async () => {
            const repo = fakeRepo();
            const adapter = fakeAdapter({ fromApplicationData: () => ({}) });
            const command = await buildCommand("Fake", adapter, repo);
            const request = syncRequest("Fake", [
                element(WbxmlCodePage.AirSync, "Add", [textElement(WbxmlCodePage.AirSync, "ClientId", "client-1")]),
            ]);
            const { ctx } = buildContext(request);

            const response = await command.handle(ctx);

            const add = findChild(findChild(collection(response!), "Responses")!, "Add")!;
            expect(childText(add, "Status")).toBe("6");
        });

        it("Rejects with Status 6 when the adapter throws parsing a malformed item, still reporting ClientId.", async () => {
            const repo = fakeRepo();
            const adapter = fakeAdapter({
                fromApplicationData: () => {
                    throw new Error("bad enum value");
                },
            });
            const command = await buildCommand("Fake", adapter, repo);
            const request = syncRequest("Fake", [
                element(WbxmlCodePage.AirSync, "Add", [
                    textElement(WbxmlCodePage.AirSync, "ClientId", "client-1"),
                    element(WbxmlCodePage.AirSync, "ApplicationData", []),
                ]),
            ]);
            const { ctx } = buildContext(request);

            const response = await command.handle(ctx);

            const add = findChild(findChild(collection(response!), "Responses")!, "Add")!;
            expect(childText(add, "ClientId")).toBe("client-1");
            expect(childText(add, "Status")).toBe("6");
        });

        it("Rejects with Status 6 when repo.create() itself throws.", async () => {
            const repo = fakeRepo({ create: vi.fn().mockRejectedValue(new Error("db error")) });
            const adapter = fakeAdapter({ fromApplicationData: () => ({}) });
            const command = await buildCommand("Fake", adapter, repo);
            const request = syncRequest("Fake", [
                element(WbxmlCodePage.AirSync, "Add", [element(WbxmlCodePage.AirSync, "ApplicationData", [])]),
            ]);
            const { ctx } = buildContext(request);

            const response = await command.handle(ctx);

            const add = findChild(findChild(collection(response!), "Responses")!, "Add")!;
            expect(childText(add, "Status")).toBe("6");
        });
    });

    describe("Change", () => {
        it("Succeeds silently (no Responses entry) and advances the persisted watermark past the write.", async () => {
            const existing = { uid: "item-1", version: 1 };
            const updated = { uid: "item-1", version: 2, dateModified: new Date("2026-02-01T00:00:00.000Z") };
            const repo = fakeRepo({
                findOne: vi.fn().mockResolvedValue(existing),
                update: vi.fn().mockResolvedValue(updated),
            });
            const adapter = fakeAdapter({ fromApplicationData: () => ({ title: "Updated" }) });
            const command = await buildCommand("Fake", adapter, repo);
            const request = syncRequest("Fake", [
                element(WbxmlCodePage.AirSync, "Change", [
                    textElement(WbxmlCodePage.AirSync, "ServerId", "item-1"),
                    element(WbxmlCodePage.AirSync, "ApplicationData", []),
                ]),
            ]);
            const { ctx } = buildContext(request);

            const response = await command.handle(ctx);

            // No Commands (nothing to report from computeChanges) and no Responses (silent success) - a bare
            // Status-1 collection, not undefined, since the request DID include Commands.
            expect(childText(collection(response!), "Status")).toBe("1");
            expect(findChild(collection(response!), "Responses")).toBeUndefined();
            expect(repo.update).toHaveBeenCalledWith({ uid: "item-1", version: 1, title: "Updated" }, existing, { ignoreACL: true });

            const newKey = ctx.deviceSyncState.folderSyncKeys[FOLDER_UID];
            expect(newKey).not.toBe(STORED_KEY);
            expect(newKey.endsWith(updated.dateModified.toISOString())).toBe(true);
        });

        it("Reports Status 8 when ServerId doesn't resolve to an existing item.", async () => {
            const repo = fakeRepo({ findOne: vi.fn().mockResolvedValue(undefined) });
            const adapter = fakeAdapter({ fromApplicationData: () => ({}) });
            const command = await buildCommand("Fake", adapter, repo);
            const request = syncRequest("Fake", [
                element(WbxmlCodePage.AirSync, "Change", [
                    textElement(WbxmlCodePage.AirSync, "ServerId", "missing-1"),
                    element(WbxmlCodePage.AirSync, "ApplicationData", []),
                ]),
            ]);
            const { ctx } = buildContext(request);

            const response = await command.handle(ctx);

            const change = findChild(findChild(collection(response!), "Responses")!, "Change")!;
            expect(childText(change, "ServerId")).toBe("missing-1");
            expect(childText(change, "Status")).toBe("8");
        });

        it("Reports Status 6 when the adapter has no fromApplicationData at all (e.g. Email).", async () => {
            const repo = fakeRepo();
            const adapter = fakeAdapter();
            const command = await buildCommand("Fake", adapter, repo);
            const request = syncRequest("Fake", [
                element(WbxmlCodePage.AirSync, "Change", [
                    textElement(WbxmlCodePage.AirSync, "ServerId", "item-1"),
                    element(WbxmlCodePage.AirSync, "ApplicationData", []),
                ]),
            ]);
            const { ctx } = buildContext(request);

            const response = await command.handle(ctx);

            const change = findChild(findChild(collection(response!), "Responses")!, "Change")!;
            expect(childText(change, "Status")).toBe("6");
            expect(repo.findOne).not.toHaveBeenCalled();
        });

        it("Reports Status 6 when ApplicationData is missing entirely.", async () => {
            const repo = fakeRepo({ findOne: vi.fn().mockResolvedValue({ uid: "item-1", version: 1 }) });
            const adapter = fakeAdapter({ fromApplicationData: () => ({}) });
            const command = await buildCommand("Fake", adapter, repo);
            const request = syncRequest("Fake", [
                element(WbxmlCodePage.AirSync, "Change", [textElement(WbxmlCodePage.AirSync, "ServerId", "item-1")]),
            ]);
            const { ctx } = buildContext(request);

            const response = await command.handle(ctx);

            const change = findChild(findChild(collection(response!), "Responses")!, "Change")!;
            expect(childText(change, "Status")).toBe("6");
        });

        it("Reports Status 7 when repo.update() rejects with an optimistic-concurrency conflict.", async () => {
            // A real single-request Change can never observe its own freshly-read `existing.version` as stale
            // (SyncCommand always echoes back the version it just read) - a genuine conflict only arises from a
            // concurrent write racing between this request's findOne() and update() (e.g. another device
            // syncing the same item at the same moment), not reproducible deterministically over real HTTP.
            // Injected directly here instead, matching MeetingResponseCommand.test.ts's own precedent for an
            // unreproducible-race branch.
            const existing = { uid: "item-1", version: 1 };
            const repo = fakeRepo({
                findOne: vi.fn().mockResolvedValue(existing),
                update: vi.fn().mockRejectedValue(new ApiError(ApiErrors.INVALID_OBJECT_VERSION, 409, "Version conflict")),
            });
            const adapter = fakeAdapter({ fromApplicationData: () => ({ title: "Updated" }) });
            const command = await buildCommand("Fake", adapter, repo);
            const request = syncRequest("Fake", [
                element(WbxmlCodePage.AirSync, "Change", [
                    textElement(WbxmlCodePage.AirSync, "ServerId", "item-1"),
                    element(WbxmlCodePage.AirSync, "ApplicationData", []),
                ]),
            ]);
            const { ctx } = buildContext(request);

            const response = await command.handle(ctx);

            const change = findChild(findChild(collection(response!), "Responses")!, "Change")!;
            expect(childText(change, "ServerId")).toBe("item-1");
            expect(childText(change, "Status")).toBe("7");
        });

        it("Reports Status 6 when repo.update() rejects with a non-conflict error.", async () => {
            const existing = { uid: "item-1", version: 1 };
            const repo = fakeRepo({
                findOne: vi.fn().mockResolvedValue(existing),
                update: vi.fn().mockRejectedValue(new Error("db error")),
            });
            const adapter = fakeAdapter({ fromApplicationData: () => ({ title: "Updated" }) });
            const command = await buildCommand("Fake", adapter, repo);
            const request = syncRequest("Fake", [
                element(WbxmlCodePage.AirSync, "Change", [
                    textElement(WbxmlCodePage.AirSync, "ServerId", "item-1"),
                    element(WbxmlCodePage.AirSync, "ApplicationData", []),
                ]),
            ]);
            const { ctx } = buildContext(request);

            const response = await command.handle(ctx);

            const change = findChild(findChild(collection(response!), "Responses")!, "Change")!;
            expect(childText(change, "Status")).toBe("6");
        });

        it("Ignores a Change command with no ServerId at all.", async () => {
            const repo = fakeRepo();
            const adapter = fakeAdapter({ fromApplicationData: () => ({}) });
            const command = await buildCommand("Fake", adapter, repo);
            const request = syncRequest("Fake", [
                element(WbxmlCodePage.AirSync, "Change", [element(WbxmlCodePage.AirSync, "ApplicationData", [])]),
            ]);
            const { ctx } = buildContext(request);

            const response = await command.handle(ctx);

            expect(findChild(collection(response!), "Responses")).toBeUndefined();
            expect(repo.findOne).not.toHaveBeenCalled();
        });
    });

    describe("Delete", () => {
        it("Succeeds silently (no Responses entry) for an existing item.", async () => {
            const existing = { uid: "item-1", version: 1 };
            const repo = fakeRepo({ findOne: vi.fn().mockResolvedValue(existing), delete: vi.fn().mockResolvedValue(undefined) });
            const adapter = fakeAdapter();
            const command = await buildCommand("Fake", adapter, repo);
            const request = syncRequest("Fake", [
                element(WbxmlCodePage.AirSync, "Delete", [textElement(WbxmlCodePage.AirSync, "ServerId", "item-1")]),
            ]);
            const { ctx } = buildContext(request);

            const response = await command.handle(ctx);

            expect(findChild(collection(response!), "Responses")).toBeUndefined();
            expect(repo.delete).toHaveBeenCalledWith("item-1", { ignoreACL: true });
        });

        it("Reports Status 8 when ServerId doesn't resolve to an existing item.", async () => {
            const repo = fakeRepo({ findOne: vi.fn().mockResolvedValue(undefined) });
            const adapter = fakeAdapter();
            const command = await buildCommand("Fake", adapter, repo);
            const request = syncRequest("Fake", [
                element(WbxmlCodePage.AirSync, "Delete", [textElement(WbxmlCodePage.AirSync, "ServerId", "missing-1")]),
            ]);
            const { ctx } = buildContext(request);

            const response = await command.handle(ctx);

            const del = findChild(findChild(collection(response!), "Responses")!, "Delete")!;
            expect(childText(del, "ServerId")).toBe("missing-1");
            expect(childText(del, "Status")).toBe("8");
        });

        it("Reports Status 6 when repo.delete() itself throws.", async () => {
            const existing = { uid: "item-1", version: 1 };
            const repo = fakeRepo({
                findOne: vi.fn().mockResolvedValue(existing),
                delete: vi.fn().mockRejectedValue(new Error("db error")),
            });
            const adapter = fakeAdapter();
            const command = await buildCommand("Fake", adapter, repo);
            const request = syncRequest("Fake", [
                element(WbxmlCodePage.AirSync, "Delete", [textElement(WbxmlCodePage.AirSync, "ServerId", "item-1")]),
            ]);
            const { ctx } = buildContext(request);

            const response = await command.handle(ctx);

            const del = findChild(findChild(collection(response!), "Responses")!, "Delete")!;
            expect(childText(del, "Status")).toBe("6");
        });

        it("Ignores a Delete command with no ServerId at all.", async () => {
            const repo = fakeRepo();
            const adapter = fakeAdapter();
            const command = await buildCommand("Fake", adapter, repo);
            const request = syncRequest("Fake", [element(WbxmlCodePage.AirSync, "Delete", [])]);
            const { ctx } = buildContext(request);

            const response = await command.handle(ctx);

            expect(findChild(collection(response!), "Responses")).toBeUndefined();
            expect(repo.findOne).not.toHaveBeenCalled();
        });
    });

    it("Persists the new SyncKey via deviceSyncStateRepo.update() exactly once per request.", async () => {
        const repo = fakeRepo({ delete: vi.fn().mockResolvedValue(undefined), findOne: vi.fn().mockResolvedValue({ uid: "item-1", version: 1 }) });
        const adapter = fakeAdapter();
        const command = await buildCommand("Fake", adapter, repo);
        const request = syncRequest("Fake", [
            element(WbxmlCodePage.AirSync, "Delete", [textElement(WbxmlCodePage.AirSync, "ServerId", "item-1")]),
        ]);
        const { ctx, deviceSyncStateUpdate } = buildContext(request);

        await command.handle(ctx);

        expect(deviceSyncStateUpdate).toHaveBeenCalledTimes(1);
    });
});
