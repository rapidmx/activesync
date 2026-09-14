///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import { createClient, type RedisClientType } from "redis";
import { ObjectDecorators } from "@rapidrest/core";
import { ACLAction, ACLUtils } from "@rapidrest/service-core";
import { WbxmlCodePage } from "../codec/WbxmlCodePages.js";
import { childText, element, findChild, findChildren, textElement, type WbxmlElement } from "../codec/WbxmlElement.js";
import type { EasCommandContext, EasCommandHandler } from "../EasCommandHandler.js";
const { Config, Inject } = ObjectDecorators;

/** MS-ASCMD `Ping` `Status` codes this pragmatic subset distinguishes - not the full enumeration the real
 * spec defines (e.g. it also has a code for "folder hierarchy changed"), matching this library's "pragmatic
 * subset, not full fidelity" precedent elsewhere. */
const STATUS_NO_CHANGES = "1";
const STATUS_CHANGES_FOUND = "2";
const STATUS_MISSING_PARAMETERS = "3";
const STATUS_TOO_MANY_FOLDERS = "6";

/** How many `ACLUtils.hasPermission()` checks run concurrently while filtering the requested folders. */
const ACL_CHECK_CHUNK_SIZE = 25;

type PingListener = (message: string, channel: string) => void;

/**
 * Handles EAS `Ping`: a long-poll HTTP request that blocks for up to `HeartbeatInterval` seconds waiting for a
 * change in any of the client-specified folders, then reports which (if any) actually changed. Every
 * `Message`/`CalendarEvent`/etc. mutation already publishes to the `folderUid` channels via
 * `BaseScopedChildRoute.notify()`/`RepoUtils`'s own push - `Ping` only needs a subscriber.
 *
 * Resource bounds:
 * - One shared Redis subscriber client per process (per Redis URL), lazily connected once. Each `Ping` attaches
 * its own listener to its channels and removes exactly that listener when it settles. A connect/subscribe
 * failure fails open (the `Ping` just waits out its heartbeat and reports no changes) and a failed connect is
 * forgotten so a later `Ping` retries it.
 * - At most one active `Ping` per (mailbox, device) per process: a newer one supersedes (answers Status 1) the
 * older one.
 * - The wait ends as soon as the HTTP response finishes (including a client abort).
 * - More than `mail:eas:ping_max_folders` folders is rejected with Status 6 before any ACL work, and the ACL
 * checks themselves run in bounded concurrent chunks.
 * - Without a `datastores:events` config the `Ping` still waits the full (clamped) heartbeat before answering
 * Status 1, so a device can't hot-loop against it.
 *
 * Requested folder uids are filtered down to only those the caller currently has `READ` on before subscribing -
 * without it a device could long-poll on any folder uid it happens to know (including one whose share was since
 * revoked) and learn from this channel when that other mailbox's data changes.
 *
 * @author Jean-Philippe Steinmetz
 */
export class PingCommand implements EasCommandHandler {
    /** Shared subscriber connections, keyed by Redis URL - each value resolves once that client is connected. */
    private static readonly subscribers: Map<string, Promise<RedisClientType>> = new Map();
    /** The cancel function of the currently active `Ping` for each (mailbox, device) pair. */
    private static readonly activePings: Map<string, () => void> = new Map();

    public readonly command = "Ping";

    // `null` (not the decorator's own literal default of `undefined`) is deliberate: `@Config()` throws at
    // injection time if neither a real value nor a non-`undefined` default is available, but a deployment
    // with no `datastores:events` block configured (Redis pub/sub not set up) is legitimate.
    @Config("datastores:events", null)
    private redisConfig: any;

    @Config("mail:eas:ping_min_heartbeat_seconds", 60)
    private minHeartbeatSeconds: number = 60;

    @Config("mail:eas:ping_max_heartbeat_seconds", 1740)
    private maxHeartbeatSeconds: number = 1740;

    @Config("mail:eas:ping_max_folders", 300)
    private maxFolders: number = 300;

    @Inject(ACLUtils)
    private aclUtils?: ACLUtils;

    /** Forgets all process-wide shared state (subscriber clients and active pings). Intended for tests. */
    public static resetSharedState(): void {
        PingCommand.subscribers.clear();
        PingCommand.activePings.clear();
    }

    public async handle(ctx: EasCommandContext): Promise<WbxmlElement | undefined> {
        if (!ctx.request) {
            return this.statusResponse(STATUS_MISSING_PARAMETERS);
        }

        const foldersEl = findChild(ctx.request, "Folders");
        const requestedFolderUids: string[] = foldersEl
            ? findChildren(foldersEl, "Folder")
                  .map((folderEl) => childText(folderEl, "ServerId"))
                  .filter((uid): uid is string => !!uid)
            : [];
        if (requestedFolderUids.length === 0) {
            return this.statusResponse(STATUS_MISSING_PARAMETERS);
        }
        if (requestedFolderUids.length > this.maxFolders) {
            return element(WbxmlCodePage.Ping, "Ping", [
                textElement(WbxmlCodePage.Ping, "Status", STATUS_TOO_MANY_FOLDERS),
                textElement(WbxmlCodePage.Ping, "MaxFolders", String(this.maxFolders)),
            ]);
        }

        // Filtered down to the permitted subset rather than failing the whole request: `Ping`'s wire response
        // has no per-folder status to report a partial denial through.
        const folderUids: string[] = await this.filterPermitted(ctx, requestedFolderUids);
        if (folderUids.length === 0) {
            return this.statusResponse(STATUS_MISSING_PARAMETERS);
        }

        const requestedSeconds: number = Number(childText(ctx.request, "HeartbeatInterval") ?? this.minHeartbeatSeconds);
        const heartbeatSeconds: number = Math.min(
            Math.max(Number.isFinite(requestedSeconds) ? requestedSeconds : this.minHeartbeatSeconds, this.minHeartbeatSeconds),
            this.maxHeartbeatSeconds,
        );

        const changedFolderUids: string[] = await this.waitForChange(ctx, folderUids, heartbeatSeconds);
        if (changedFolderUids.length === 0) {
            return this.statusResponse(STATUS_NO_CHANGES);
        }

        return element(WbxmlCodePage.Ping, "Ping", [
            textElement(WbxmlCodePage.Ping, "Status", STATUS_CHANGES_FOUND),
            element(
                WbxmlCodePage.Ping,
                "Folders",
                changedFolderUids.map((uid) => textElement(WbxmlCodePage.Ping, "Folder", uid)),
            ),
        ]);
    }

    private statusResponse(status: string): WbxmlElement {
        return element(WbxmlCodePage.Ping, "Ping", [textElement(WbxmlCodePage.Ping, "Status", status)]);
    }

    /** Returns the subset of `folderUids` the caller has `READ` on, checking at most `ACL_CHECK_CHUNK_SIZE` at once. */
    private async filterPermitted(ctx: EasCommandContext, folderUids: string[]): Promise<string[]> {
        const result: string[] = [];
        for (let i = 0; i < folderUids.length; i += ACL_CHECK_CHUNK_SIZE) {
            const chunk = folderUids.slice(i, i + ACL_CHECK_CHUNK_SIZE);
            const permitted = await Promise.all(
                chunk.map((uid) => this.aclUtils!.hasPermission(ctx.user, uid, ACLAction.READ)),
            );
            result.push(...chunk.filter((_uid, j) => permitted[j]));
        }
        return result;
    }

    /** Returns the process-wide subscriber client for `url`, connecting it on first use. A failed connect is
     * evicted from the cache (and the client destroyed) so a later call retries. */
    private static getSubscriber(url: string): Promise<RedisClientType> {
        let pending = PingCommand.subscribers.get(url);
        if (!pending) {
            const client = createClient({ url }) as RedisClientType;
            // An unhandled `error` event would crash the process; the client reconnects on its own.
            client.on("error", () => undefined);
            const connecting: Promise<RedisClientType> = client.connect().then(() => client);
            connecting.catch(() => {
                if (PingCommand.subscribers.get(url) === connecting) {
                    PingCommand.subscribers.delete(url);
                }
                try {
                    client.destroy();
                } catch {
                    // ignored
                }
            });
            PingCommand.subscribers.set(url, connecting);
            pending = connecting;
        }
        return pending;
    }

    /** Waits up to `timeoutSeconds` for a publish on any of `folderUids`, resolving with the channel that changed,
     * or `[]` on timeout, supersede by a newer `Ping` from the same device, request close, or Redis being
     * unavailable (in which case the full heartbeat is still waited). */
    private waitForChange(ctx: EasCommandContext, folderUids: string[], timeoutSeconds: number): Promise<string[]> {
        const key: string = JSON.stringify([ctx.mailboxUid, ctx.deviceId]);
        const redisUrl: string | undefined = this.redisConfig ? this.redisConfig.url : undefined;

        return new Promise<string[]>((resolve) => {
            let settled = false;
            let unsubscribe: (() => Promise<void>) | undefined;

            const finish = (changed: string[]): void => {
                if (settled) {
                    return;
                }
                settled = true;
                clearTimeout(timer);
                if (PingCommand.activePings.get(key) === cancel) {
                    PingCommand.activePings.delete(key);
                }
                if (unsubscribe) {
                    void unsubscribe();
                }
                resolve(changed);
            };
            const cancel = (): void => finish([]);

            PingCommand.activePings.get(key)?.();
            PingCommand.activePings.set(key, cancel);
            const timer = setTimeout(cancel, timeoutSeconds * 1000);
            ctx.res?.onFinish(cancel);

            if (redisUrl === undefined) {
                return;
            }

            const listener: PingListener = (_message, channel) => finish([channel]);
            PingCommand.getSubscriber(redisUrl)
                .then(async (client) => {
                    if (settled) {
                        return;
                    }
                    const release = (): Promise<void> => client.unsubscribe(folderUids, listener).catch(() => undefined);
                    try {
                        await client.subscribe(folderUids, listener);
                    } catch {
                        // Fail open: keep waiting out the heartbeat, just without notifications.
                    }
                    if (settled) {
                        // Settled while the subscribe was in flight - `finish()` had nothing to release yet.
                        await release();
                    } else {
                        unsubscribe = release;
                    }
                })
                .catch(() => {
                    // Connect failed - fail open, the timer/cancel still answers Status 1.
                });
        });
    }
}
