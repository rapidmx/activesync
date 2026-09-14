///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import type { BaseEntity } from "@rapidrest/service-core";

/**
 * Tracks the EAS sync state of a single paired mobile device against a `Mailbox`.
 *
 * @author Jean-Philippe Steinmetz
 */
export interface DeviceSyncState extends BaseEntity {
    mailboxUid: string;

    deviceId: string;

    deviceType: string;

    /** The EAS provisioning policy key most recently acknowledged by the device. */
    policyKey?: string;

    /** The per-folder EAS `SyncKey` cursor, keyed by `Folder.uid`. */
    folderSyncKeys: Record<string, string>;

    /** The EAS `Class` (`"Email"`, `"Contacts"`, ...) most recently synced for a folder, keyed by `Folder.uid` -
     * lets a `Sync` request omit `Class` after its first request for a collection, per [MS-ASCMD], without the
     * server losing track of which entity type that collection holds. */
    folderCollectionClasses: Record<string, string>;

    lastSyncAt?: Date;

    provisioned: boolean;

    /** `true` once an administrator has requested this device be remotely wiped (MS-ASPROV `RemoteWipe`). Set
     * back to `false` once the device acknowledges the wipe. */
    remoteWipeRequested?: boolean;

    /** `true` if the pending/most recent remote wipe request was scoped to this account only (vs. a full device
     * wipe) - recorded for administrative record-keeping; the wire directive sent to the device is the same
     * either way in this library's pragmatic subset. */
    remoteWipeAccountOnly?: boolean;

    /** When the device most recently acknowledged a remote wipe request. */
    remoteWipeAcknowledgedAt?: Date;
}
