///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import { FolderType } from "@rapidmx/restapi";
import { isGenuineDraft, planMessageMove } from "../src/MessageMoveRules.js";

const message = (overrides: Record<string, any> = {}): any => ({ uid: "m1", folderUid: "f", ...overrides });

describe("MessageMoveRules Tests", () => {
    it("Never allows a move into Outbox, from anywhere.", () => {
        for (const source of [FolderType.DRAFTS, FolderType.INBOX, FolderType.OUTBOX, undefined]) {
            expect(planMessageMove(message(), source, FolderType.OUTBOX)).toEqual({ allowed: false, reason: "destination" });
        }
    });

    it("Allows a move into Drafts only from Drafts or Outbox.", () => {
        for (const source of [FolderType.INBOX, FolderType.SENT_ITEMS, FolderType.ARCHIVE, undefined]) {
            expect(planMessageMove(message(), source, FolderType.DRAFTS)).toEqual({ allowed: false, reason: "destination" });
        }
        expect(planMessageMove(message(), FolderType.DRAFTS, FolderType.DRAFTS)).toEqual({ allowed: true, patch: {} });
        expect(planMessageMove(message(), FolderType.INBOX, FolderType.ARCHIVE)).toEqual({ allowed: true, patch: {} });
    });

    it("Cancels the scheduled send of a message leaving Outbox, clearing only the retry fields the row has, and refuses a relayed one.", () => {
        expect(planMessageMove(message({ scheduledSendTime: new Date() }), FolderType.OUTBOX, FolderType.DRAFTS)).toEqual({
            allowed: true,
            patch: { scheduledSendTime: null },
        });
        expect(planMessageMove(message({ scheduledSendAttempts: 1, scheduledSendError: "x" }), FolderType.OUTBOX, FolderType.ARCHIVE)).toEqual({
            allowed: true,
            patch: { scheduledSendTime: null, scheduledSendAttempts: null, scheduledSendError: null },
        });
        expect(planMessageMove(message({ scheduledSendRelayedAt: new Date() }), FolderType.OUTBOX, FolderType.DRAFTS)).toEqual({ allowed: false, reason: "sent" });
    });

    it("Refuses to move a message whose send is in flight anywhere, and clears a lapsed lease when it leaves Outbox.", () => {
        const live = new Date(Date.now() + 60_000);
        for (const lease of [live, live.toISOString()]) {
            expect(planMessageMove(message({ scheduledSendLeaseExpiresAt: lease }), FolderType.OUTBOX, FolderType.DRAFTS)).toEqual({ allowed: false, reason: "inFlight" });
            expect(planMessageMove(message({ scheduledSendLeaseExpiresAt: lease }), FolderType.INBOX, FolderType.ARCHIVE)).toEqual({ allowed: false, reason: "inFlight" });
        }
        for (const lapsed of [new Date(Date.now() - 1000), null, "not a date"]) {
            expect(planMessageMove(message({ scheduledSendLeaseExpiresAt: lapsed }), FolderType.OUTBOX, FolderType.DRAFTS)).toEqual({
                allowed: true,
                patch: { scheduledSendTime: null, scheduledSendLeaseExpiresAt: null },
            });
        }
    });

    it("Treats only an undelivered message in Drafts as a genuine draft.", () => {
        expect(isGenuineDraft(message(), FolderType.DRAFTS)).toBe(true);
        expect(isGenuineDraft(message({ scanResultUid: "scan" }), FolderType.DRAFTS)).toBe(false);
        expect(isGenuineDraft(message(), FolderType.INBOX)).toBe(false);
        expect(isGenuineDraft(message(), undefined)).toBe(false);
    });
});
