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

/** Whether a send of `message` is in flight: its `scheduledSendLeaseExpiresAt` (set when `send()` or `ScheduledSendJob`
 * claims it for relay) is still in the future. restapi refuses to move or delete such a message (409,
 * `assertNotInFlight()`): a moved or soft-deleted message could miss its relay marker and be sent a second time. */
export function hasLiveSendLease(message: Message): boolean {
    const lease: Date | undefined = toValidDate((message as any).scheduledSendLeaseExpiresAt);
    return lease !== undefined && lease.getTime() > Date.now();
}

/** The outcome of `planMessageMove()`: refused (with why), or allowed with extra fields the move's update must carry. */
export type MessageMovePlan = { allowed: false; reason: "destination" | "sent" | "inFlight" } | { allowed: true; patch: Record<string, unknown> };

/**
 * Decides whether an ActiveSync client may move `message` from a folder of `sourceType` into one of `destinationType`,
 * matching restapi's own REST rules for a non-trusted caller (`BaseMessageRoute.prepareScheduledSendUpdate()`), plus
 * one of this plugin's own:
 * - **Into Outbox** is always refused (`"destination"`): only a send puts a message there, after checking its sender -
 * `ScheduledSendJob` relays whatever it finds in Outbox.
 * - **Into Drafts** is refused unless the message already is in Drafts, or is taken back out of Outbox to cancel its send
 * (`"destination"`): a draft's body can be rewritten over ActiveSync (`EmailSyncAdapter.fromApplicationData`), so moving a
 * received, sent or held message into Drafts, editing it and moving it back would forge its content under its original
 * sender and dates. Out of Outbox only for what a send queued: a delivered message (`scanResultUid`) a mail filter rule
 * filed into Outbox is refused, as restapi refuses it with 403.
 * - **A send in flight** (`hasLiveSendLease()` - claimed for relay by `send()` or `ScheduledSendJob`) can't be moved
 * anywhere (`"inFlight"`), as restapi's `assertNotInFlight()` refuses with 409: moving it back to Drafts would let it be
 * sent again while the first relay still runs. Once the lease has lapsed, it can move. Deletes check the same.
 * - **Out of Outbox** cancels the scheduled send: the plan clears `scheduledSendTime`, the job's retry state and its
 * lease (`scheduledSendAttempts`/`scheduledSendError`/`scheduledSendLeaseExpiresAt`, only where the stored row has them -
 * the SQL model of restapi 0.9.0 has no such columns). A message the job already relayed (`scheduledSendRelayedAt`, whose
 * filing is still pending) is refused (`"sent"`).
 */
export function planMessageMove(message: Message, sourceType: FolderType | undefined, destinationType: FolderType | undefined): MessageMovePlan {
    if (hasLiveSendLease(message)) {
        return { allowed: false, reason: "inFlight" };
    }
    if (destinationType === FolderType.OUTBOX) {
        return { allowed: false, reason: "destination" };
    }
    // A send only queues drafts: moving one back to Drafts cancels the send. A delivered message in Outbox isn't one.
    const cancellingSend: boolean = sourceType === FolderType.OUTBOX && !message.scanResultUid;
    if (destinationType === FolderType.DRAFTS && sourceType !== FolderType.DRAFTS && !cancellingSend) {
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
 * `Message` fields only a delivery or a send ever sets - server-managed in restapi (a client's create/update can't set
 * them), and never present on a draft composed over ActiveSync (`EmailSyncAdapter`), REST or webmail compose:
 * - `scanResultUid`: inbound delivery (and import) scanned the message into the mailbox;
 * - `scheduledSendRelayedAt`: the transport accepted it (set until it is filed into Sent Items);
 * - `sanitizedHtmlBlobKey`: a scan produced sanitized HTML - a delivery, or `scanAndRelay()` on a send, which keeps it on
 * the Sent Items copy (a draft is never scanned);
 * - `encrypted: true`: computed by the same scan;
 * - `recallRequestedAt`: `recall()` only works on a sent message;
 * - a non-empty `receiptStatus`: seeded when a sent message is filed.
 */
const SENT_OR_DELIVERED_MARKERS: ((message: any) => boolean)[] = [
    (message) => !!message.scanResultUid,
    (message) => message.scheduledSendRelayedAt != null,
    (message) => !!message.sanitizedHtmlBlobKey,
    (message) => message.encrypted === true,
    (message) => message.recallRequestedAt != null,
    (message) => Array.isArray(message.receiptStatus) && message.receiptStatus.length > 0,
];

/**
 * Whether `message`, filed in a folder of `folderType`, is a genuine draft whose content an ActiveSync client may
 * rewrite: it lives in Drafts and carries none of the marks a delivery or a send leaves (`SENT_OR_DELIVERED_MARKERS`).
 * Moves into Drafts are refused over ActiveSync (`planMessageMove()`), but a message can still reach Drafts other ways
 * (restapi's REST moves out of Outbox, a mail filter, an import), so a delivered or sent message found there is not
 * treated as a draft.
 *
 * `sentDate` can't be the marker: every message has one, and a draft gets it when it is created. **Residual**: a
 * plain-text, unencrypted sent copy with no receipt request carries none of these marks; restapi keeps it out of
 * Drafts (non-trusted moves into Drafts only from Drafts or Outbox, and only a send from Drafts queues into Outbox).
 */
export function isGenuineDraft(message: Message, folderType: FolderType | undefined): boolean {
    return folderType === FolderType.DRAFTS && !SENT_OR_DELIVERED_MARKERS.some((isMarked) => isMarked(message));
}
