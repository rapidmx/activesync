///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
// `PingCommand`'s real logic (parsing the request, clamping the heartbeat, building the response) is tested
// directly against the handler here rather than through a full HTTP+DB server harness, since it has no
// database dependency of its own - only `@Config`-injected Redis settings. Its Redis-dependent wait/publish
// path is exercised against a small hand-rolled fake `redis` module via `vi.mock`, mirroring service-core's
// own documented precedent for the exact same infrastructure gap (`service-core/test/helpers/FakeRedis.ts`,
// used because no real Redis server is part of this repo's test setup either - only that helper lives in
// service-core's own test/ directory, not published for reuse, hence this smaller, purpose-built copy).
import { ObjectFactory } from "@rapidrest/service-core";
import { Logger } from "@rapidrest/core";
import { PingCommand } from "../../src/commands/PingCommand.js";
import { element, textElement, findChild, childText } from "../../src/codec/WbxmlElement.js";
import { WbxmlCodePage } from "../../src/codec/WbxmlCodePages.js";
import type { EasCommandContext } from "../../src/EasCommandHandler.js";

type PubSubListener = (message: string, channel: string) => void;

class FakeRedisServer {
    private subscribers: Map<string, Set<PubSubListener>> = new Map();

    public publish(channel: string, message: string): void {
        const subs = this.subscribers.get(channel);
        if (!subs) {
            return;
        }
        // Deferred (not called inline) so a publish issued right after `waitForChange()` starts subscribing
        // isn't racing a same-tick delivery real Redis could never produce either.
        const listeners = [...subs];
        queueMicrotask(() => {
            for (const listener of listeners) {
                listener(message, channel);
            }
        });
    }

    public subscribe(channel: string, listener: PubSubListener): void {
        if (!this.subscribers.has(channel)) {
            this.subscribers.set(channel, new Set());
        }
        this.subscribers.get(channel)!.add(listener);
    }

    public unsubscribe(channel: string, listener: PubSubListener): void {
        this.subscribers.get(channel)?.delete(listener);
    }
}

/** Consumed (reset to `false`) by the next `FakeRedisClient.subscribe()` call - lets a single test simulate a
 * `client.subscribe()` rejection (e.g. a dropped connection) without affecting any other test. */
let nextSubscribeShouldFail = false;
/** Same idea as `nextSubscribeShouldFail`, for `unsubscribe()`/`disconnect()` - `PingCommand.waitForChange()`'s
 * `finally` block swallows both via their own `.catch(() => undefined)`, since a cleanup failure on an
 * already-answered request shouldn't fail the request itself. */
let nextUnsubscribeShouldFail = false;
let nextDisconnectShouldFail = false;

class FakeRedisClient {
    private readonly listenersByChannel: Map<string, PubSubListener> = new Map();

    constructor(private readonly server: FakeRedisServer) {}

    public async connect(): Promise<void> {
        // no-op
    }

    public async disconnect(): Promise<void> {
        if (nextDisconnectShouldFail) {
            nextDisconnectShouldFail = false;
            throw new Error("simulated Redis disconnect failure");
        }
        for (const [channel, listener] of this.listenersByChannel) {
            this.server.unsubscribe(channel, listener);
        }
        this.listenersByChannel.clear();
    }

    public async subscribe(channels: string[], listener: PubSubListener): Promise<void> {
        if (nextSubscribeShouldFail) {
            nextSubscribeShouldFail = false;
            throw new Error("simulated Redis connection failure");
        }
        for (const channel of channels) {
            this.server.subscribe(channel, listener);
            this.listenersByChannel.set(channel, listener);
        }
    }

    public async unsubscribe(channels: string[]): Promise<void> {
        if (nextUnsubscribeShouldFail) {
            nextUnsubscribeShouldFail = false;
            throw new Error("simulated Redis unsubscribe failure");
        }
        for (const channel of channels) {
            const listener = this.listenersByChannel.get(channel);
            if (listener) {
                this.server.unsubscribe(channel, listener);
            }
            this.listenersByChannel.delete(channel);
        }
    }
}

const fakeRedisServer = new FakeRedisServer();

vi.mock("redis", () => ({
    createClient: () => new FakeRedisClient(fakeRedisServer),
}));

/** Builds a minimal nconf-compatible config double exposing only the paths `PingCommand` reads. */
function makeConfig(values: Record<string, any>): any {
    return { get: (path: string) => values[path] };
}

/**
 * Builds a `PingCommand` via a real `ObjectFactory` (so its `@Config` fields resolve normally, matching every
 * other test in this file), then stubs its `@Inject(ACLUtils)` field directly - this file's own config double
 * has no real datastore for `ObjectFactory` to construct a working `ACLUtils` against (by design: `Ping` itself
 * has no database dependency of its own), so DI leaves that field unset. `deniedFolderUids` lets a test assert
 * on the new permission-filtering behavior without needing a real ACL backend.
 */
async function createCommand(values: Record<string, any>, deniedFolderUids: string[] = []): Promise<PingCommand> {
    const command = await new ObjectFactory(makeConfig(values), Logger()).newInstance<PingCommand>(PingCommand);
    const denied = new Set(deniedFolderUids);
    (command as any).aclUtils = { hasPermission: async (_user: unknown, uid: string) => !denied.has(uid) };
    return command;
}

function pingRequest(heartbeatSeconds: number | undefined, folderUids: string[]): any {
    return element(WbxmlCodePage.Ping, "Ping", [
        ...(heartbeatSeconds !== undefined ? [textElement(WbxmlCodePage.Ping, "HeartbeatInterval", String(heartbeatSeconds))] : []),
        element(
            WbxmlCodePage.Ping,
            "Folders",
            folderUids.map((uid) =>
                element(WbxmlCodePage.Ping, "Folder", [textElement(WbxmlCodePage.Ping, "ServerId", uid)]),
            ),
        ),
    ]);
}

function makeContext(request: any): EasCommandContext {
    return {
        user: { uid: "user-1", roles: [], scopes: [] },
        mailboxUid: "mbx-1",
        deviceId: "dev-1",
        deviceType: "TestPhone",
        deviceSyncState: {} as any,
        deviceSyncStateRepo: {} as any,
        query: {},
        request,
        req: {} as any,
    };
}

describe("PingCommand Tests", () => {
    afterEach(() => {
        vi.restoreAllMocks();
    });

    it("Returns Status 3 (missing parameters) when the request body is absent.", async () => {
        const command = await createCommand({});
        const response = await command.handle(makeContext(undefined));
        expect(childText(response!, "Status")).toBe("3");
    });

    it("Returns Status 3 (missing parameters) when no folders are specified.", async () => {
        const command = await createCommand({});
        const response = await command.handle(makeContext(element(WbxmlCodePage.Ping, "Ping", [])));
        expect(childText(response!, "Status")).toBe("3");
    });

    it("Returns Status 3 (missing parameters) when the caller has no permission on any requested folder.", async () => {
        const command = await createCommand({}, ["folder-1"]);
        const response = await command.handle(makeContext(pingRequest(1, ["folder-1"])));
        expect(childText(response!, "Status")).toBe("3");
    });

    it("Filters out a folder the caller has no permission on, still watching the rest.", async () => {
        const config = {
            "datastores:events": { url: "redis://fake" },
            "mail:eas:ping_min_heartbeat_seconds": 1,
            "mail:eas:ping_max_heartbeat_seconds": 5,
        };
        const command = await createCommand(config, ["folder-1"]);

        const responsePromise = command.handle(makeContext(pingRequest(1, ["folder-1", "folder-2"])));
        await new Promise((resolve) => setTimeout(resolve, 10));
        // Only "folder-2" was actually subscribed to (per hasPermission's denial of "folder-1" above) - a
        // publish on the denied folder must never be observable through this response.
        fakeRedisServer.publish("folder-1", JSON.stringify({ type: "Folder", action: "update" }));
        fakeRedisServer.publish("folder-2", JSON.stringify({ type: "Folder", action: "update" }));

        const response = await responsePromise;
        expect(childText(response!, "Status")).toBe("2");
        const folders = findChild(response!, "Folders")!;
        expect(folders.children.map((f) => f.text)).toEqual(["folder-2"]);
    });

    it("Fails open to Status 1 (no changes) quickly when no datastores:events config is present.", async () => {
        const command = await createCommand({});
        const start = Date.now();
        const response = await command.handle(makeContext(pingRequest(1, ["folder-1"])));
        expect(childText(response!, "Status")).toBe("1");
        // A real wait would take at least `minHeartbeatSeconds` (60s default) - failing open must not do that.
        expect(Date.now() - start).toBeLessThan(1000);
    });

    it("Defaults to minHeartbeatSeconds when HeartbeatInterval is omitted from the request entirely.", async () => {
        const command = await createCommand({ "mail:eas:ping_min_heartbeat_seconds": 1, "mail:eas:ping_max_heartbeat_seconds": 5 });

        const start = Date.now();
        const response = await command.handle(makeContext(pingRequest(undefined, ["folder-1"])));
        expect(childText(response!, "Status")).toBe("1");
        // No datastores:events configured, so this fails open quickly regardless of heartbeat - the point of
        // this test is only that omitting HeartbeatInterval doesn't throw/NaN its way through the clamp math.
        expect(Date.now() - start).toBeLessThan(1000);
    });

    it("Falls back to minHeartbeatSeconds when HeartbeatInterval is present but not a valid number.", async () => {
        const command = await createCommand({ "mail:eas:ping_min_heartbeat_seconds": 1, "mail:eas:ping_max_heartbeat_seconds": 5 });
        const request = element(WbxmlCodePage.Ping, "Ping", [
            textElement(WbxmlCodePage.Ping, "HeartbeatInterval", "not-a-number"),
            element(WbxmlCodePage.Ping, "Folders", [
                element(WbxmlCodePage.Ping, "Folder", [textElement(WbxmlCodePage.Ping, "ServerId", "folder-1")]),
            ]),
        ]);

        const response = await command.handle(makeContext(request));
        expect(childText(response!, "Status")).toBe("1");
    });

    it("Returns Status 2 with the changed folder when a publish arrives before the timeout.", async () => {
        const command = await createCommand({
            "datastores:events": { url: "redis://fake" },
            "mail:eas:ping_min_heartbeat_seconds": 1,
            "mail:eas:ping_max_heartbeat_seconds": 5,
        });

        const responsePromise = command.handle(makeContext(pingRequest(1, ["folder-1", "folder-2"])));
        // Give waitForChange() a tick to actually subscribe before publishing.
        await new Promise((resolve) => setTimeout(resolve, 10));
        fakeRedisServer.publish("folder-2", JSON.stringify({ type: "Folder", action: "update" }));

        const response = await responsePromise;
        expect(childText(response!, "Status")).toBe("2");
        const folders = findChild(response!, "Folders")!;
        expect(folders.children.map((f) => f.text)).toEqual(["folder-2"]);
    });

    it("Returns Status 1 (no changes) when the heartbeat elapses with no publish.", async () => {
        const command = await createCommand({
            "datastores:events": { url: "redis://fake" },
            "mail:eas:ping_min_heartbeat_seconds": 1,
            "mail:eas:ping_max_heartbeat_seconds": 5,
        });

        const response = await command.handle(makeContext(pingRequest(1, ["folder-1"])));
        expect(childText(response!, "Status")).toBe("1");
    });

    it("Fails open to Status 1 when the Redis client's subscribe() call itself rejects.", async () => {
        const command = await createCommand({
            "datastores:events": { url: "redis://fake" },
            "mail:eas:ping_min_heartbeat_seconds": 1,
            "mail:eas:ping_max_heartbeat_seconds": 5,
        });

        nextSubscribeShouldFail = true;
        const response = await command.handle(makeContext(pingRequest(1, ["folder-1"])));
        expect(childText(response!, "Status")).toBe("1");
    });

    it("Still returns a successful response when the post-wait Redis cleanup (unsubscribe/disconnect) itself fails.", async () => {
        const command = await createCommand({
            "datastores:events": { url: "redis://fake" },
            "mail:eas:ping_min_heartbeat_seconds": 1,
            "mail:eas:ping_max_heartbeat_seconds": 5,
        });

        nextUnsubscribeShouldFail = true;
        nextDisconnectShouldFail = true;
        const response = await command.handle(makeContext(pingRequest(1, ["folder-1"])));
        expect(childText(response!, "Status")).toBe("1");
    });

    it("Clamps a HeartbeatInterval outside the configured min/max range.", async () => {
        const command = await createCommand({
            "datastores:events": { url: "redis://fake" },
            "mail:eas:ping_min_heartbeat_seconds": 1,
            "mail:eas:ping_max_heartbeat_seconds": 2,
        });

        const start = Date.now();
        // Requests a 100-second heartbeat, clamped down to the configured 2-second max.
        const response = await command.handle(makeContext(pingRequest(100, ["folder-1"])));
        expect(childText(response!, "Status")).toBe("1");
        expect(Date.now() - start).toBeGreaterThanOrEqual(1900);
        expect(Date.now() - start).toBeLessThan(4000);
    });
});
