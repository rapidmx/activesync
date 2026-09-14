///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import { FolderType, type Message } from "@rapidmx/restapi";

/** `ScheduledSendJob`'s per-send retry state (restapi source), cleared with `scheduledSendTime` when a queued message
 * leaves Outbox. Not all of these exist in `@rapidmx/restapi` 0.9.0 - see `planMessageMove()`. */
const SCHEDULED_SEND_RETRY_FIELDS = ["scheduledSendAttempts", "scheduledSendError", "scheduledSendLeaseExpiresAt"] as const;

/** Parses a stored date that may come back as a `Date` or (Mongo) an ISO string; `undefined` if it isn't one. Copy of
 * restapi's `toValidDate()` (`routes/BaseMessageRoute.ts`). */
function toValidDate(value: unknown): Date | undefined {
    const date: Date | undefined =
        value instanceof Date ? value : typeof value === "string" || typeof value === "number" ? new Date(value) : undefined;
    return date && !Number.isNaN(date.getTime()) ? date : undefined;
}

/** The outcome of `planMessageMove()`: refused (with why), or allowed with extra fields the move's update must carry. */
export type MessageMovePlan = { allowed: false; reason: "destination" | "sent" | "inFlight" } | { allowed: true; patch: Record<string, unknown> };

/**
 * Decides whether an ActiveSync client may move `message` from a folder of `sourceType` into one of `destinationType`,
 * matching restapi's own REST rules for a non-trusted caller (`BaseMessageRoute.prepareScheduledSendUpdate()`), plus
 * one of this plugin's own:
 * - **Into Outbox** is always refused (`"destination"`): only a send puts a message there, after checking its sender -
 * `ScheduledSendJob` relays whatever it finds in Outbox.
 * - **Into Drafts** is refused unless the message already is a draft (`"destination"`): a draft's body can be rewritten
 * over ActiveSync (`EmailSyncAdapter.fromApplicationData`), so moving a received, sent or held message into Drafts,
 * editing it and moving it back would forge its content under its original sender and dates.
 * - **A send in flight** (`scheduledSendLeaseExpiresAt` still in the future - claimed for relay by `send()` or
 * `ScheduledSendJob`) can't be moved anywhere (`"inFlight"`), as restapi's `assertNotInFlight()` refuses with 409: moving it
 * back to Drafts would let it be sent again while the first relay still runs. Once the lease has lapsed, it can move.
 * - **Out of Outbox** cancels the scheduled send: the plan clears `scheduledSendTime`, the job's retry state and its
 * lease (`scheduledSendAttempts`/`scheduledSendError`/`scheduledSendLeaseExpiresAt`, only where the stored row has them -
 * the SQL model of restapi 0.9.0 has no such columns). A message the job already relayed (`scheduledSendRelayedAt`, whose
 * filing is still pending) is refused (`"sent"`).
 */
export function planMessageMove(message: Message, sourceType: FolderType | undefined, destinationType: FolderType | undefined): MessageMovePlan {
    const lease: Date | undefined = toValidDate((message as any).scheduledSendLeaseExpiresAt);
    if (lease && lease.getTime() > Date.now()) {
        return { allowed: false, reason: "inFlight" };
    }
    if (destinationType === FolderType.OUTBOX) {
        return { allowed: false, reason: "destination" };
    }
    // Outbox only ever holds messages `send()` queued from Drafts: moving one back to Drafts cancels the send.
    if (destinationType === FolderType.DRAFTS && sourceType !== FolderType.DRAFTS && sourceType !== FolderType.OUTBOX) {
        return { allowed: false, reason: "destination" };
    }
    const patch: Record<string, unknown> = {};
    if (sourceType === FolderType.OUTBOX) {
        if ((message as any).scheduledSendRelayedAt) {
            return { allowed: false, reason: "sent" };
        }
        patch.scheduledSendTime = null;
        for (const field of SCHEDULED_SEND_RETRY_FIELDS) {
            if (field in message) {
                patch[field] = null;
            }
        }
    }
    return { allowed: true, patch };
}

/**
 * Whether `message`, filed in a folder of `folderType`, is a genuine draft whose content an ActiveSync client may
 * rewrite: it lives in Drafts and was never delivered (no `scanResultUid` - only inbound delivery scans a message into a
 * mailbox). Moves into Drafts are refused over ActiveSync (`planMessageMove()`), but restapi's REST API still allows
 * them, so a delivered message found in Drafts is not treated as a draft.
 */
export function isGenuineDraft(message: Message, folderType: FolderType | undefined): boolean {
    return folderType === FolderType.DRAFTS && !message.scanResultUid;
}
