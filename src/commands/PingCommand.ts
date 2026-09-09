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
 * spec defines (e.g. it also has codes for "too many folders", "folder hierarchy changed", etc.), matching
 * this library's "pragmatic subset, not full fidelity" precedent elsewhere. */
const STATUS_NO_CHANGES = "1";
const STATUS_CHANGES_FOUND = "2";
const STATUS_MISSING_PARAMETERS = "3";

/**
 * Handles EAS `Ping`: a long-poll HTTP request that blocks for up to `HeartbeatInterval` seconds waiting for a
 * change in any of the client-specified folders, then reports which (if any) actually changed. No websocket
 * needed - subscribes a plain, request-scoped Redis client (the same construction `BasePushRoute.connect()`
 * uses, minus its own per-socket bookkeeping this one-shot request doesn't need) directly to the requested
 * `folderUid` channels. Every `Message`/`CalendarEvent`/etc. mutation already publishes to exactly these
 * channels via `BaseScopedChildRoute.notify()`/`RepoUtils`'s own push - `Ping` needs no new publish call site
 * of its own, only a subscriber.
 *
 * Requested folder uids are filtered down to only those the caller currently has `READ` on before subscribing -
 * matching every other command's ownership check on a client-supplied id, since without it a device could
 * long-poll indefinitely on any folder uid it happens to know (including one it used to have legitimate access
 * to and no longer does) and learn purely from this channel when that other mailbox's data changes.
 *
 * @author Jean-Philippe Steinmetz
 */
export class PingCommand implements EasCommandHandler {
    public readonly command = "Ping";

    // `null` (not the decorator's own literal default of `undefined`) is deliberate: `@Config()` throws at
    // injection time if neither a real value nor a non-`undefined` default is available, but a deployment
    // with no `datastores:events` block configured (Redis pub/sub not set up) is legitimate - `Ping` degrades
    // to "no changes" in that case (see `waitForChange()`) rather than the whole command failing to construct.
    @Config("datastores:events", null)
    private redisConfig: any;

    @Config("mail:eas:ping_min_heartbeat_seconds", 60)
    private minHeartbeatSeconds: number = 60;

    @Config("mail:eas:ping_max_heartbeat_seconds", 1740)
    private maxHeartbeatSeconds: number = 1740;

    @Inject(ACLUtils)
    private aclUtils?: ACLUtils;

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

        // Every other command checks ownership before acting on a client-supplied folder id - `Ping` must too,
        // or a device that once had a folder shared with it (and so learned its real uid) could keep watching
        // that folder's live activity via this long-poll indefinitely, even after the share is later revoked.
        // Filtered down to the permitted subset rather than failing the whole request: `Ping`'s wire response
        // has no per-folder status to report a partial denial through, and a client legitimately re-sends the
        // same folder list across requests regardless of access changes it has no way to know about yet.
        const permitted = await Promise.all(
            requestedFolderUids.map((uid) => this.aclUtils!.hasPermission(ctx.user, uid, ACLAction.READ)),
        );
        const folderUids = requestedFolderUids.filter((_uid, i) => permitted[i]);
        if (folderUids.length === 0) {
            return this.statusResponse(STATUS_MISSING_PARAMETERS);
        }

        const requestedSeconds: number = Number(childText(ctx.request, "HeartbeatInterval") ?? this.minHeartbeatSeconds);
        const heartbeatSeconds: number = Math.min(
            Math.max(Number.isFinite(requestedSeconds) ? requestedSeconds : this.minHeartbeatSeconds, this.minHeartbeatSeconds),
            this.maxHeartbeatSeconds,
        );

        const changedFolderUids: string[] = await this.waitForChange(folderUids, heartbeatSeconds);
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

    /** Subscribes to `folderUids` and resolves with whichever of them published a change first, or `[]` if
     * `timeoutSeconds` elapses with no publish. A missing `datastores:events` config (Redis pub/sub not set up
     * for this deployment) fails open to "no changes" rather than blocking forever or throwing - `Ping` is a
     * best-effort low-latency notification path, not the only way a client ever discovers new mail (it will
     * eventually poll a real `Sync`/`FolderSync` regardless). */
    private async waitForChange(folderUids: string[], timeoutSeconds: number): Promise<string[]> {
        if (!this.redisConfig) {
            return [];
        }

        const client: RedisClientType = createClient({ url: this.redisConfig.url });
        await client.connect();
        try {
            return await new Promise<string[]>((resolve) => {
                let settled = false;
                const timer = setTimeout(() => {
                    if (!settled) {
                        settled = true;
                        resolve([]);
                    }
                }, timeoutSeconds * 1000);

                client
                    .subscribe(folderUids, (_message: string, channel: string) => {
                        if (!settled) {
                            settled = true;
                            clearTimeout(timer);
                            resolve([channel]);
                        }
                    })
                    .catch(() => {
                        if (!settled) {
                            settled = true;
                            clearTimeout(timer);
                            resolve([]);
                        }
                    });
            });
        } finally {
            await client.unsubscribe(folderUids).catch(() => undefined);
            await client.disconnect().catch(() => undefined);
        }
    }
}
