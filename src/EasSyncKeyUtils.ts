///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import type { RecoverableBaseEntity, RepoUtils } from "@rapidrest/service-core";

/**
 * A parsed EAS `SyncKey`. The wire value is opaque to the client per spec, so this library encodes it as
 * `"<generation>:<watermarkIso>"` (e.g. `"3:2026-09-04T12:00:00.000Z"`) - a monotonic generation counter (bumped
 * once per successful sync round, satisfying the spec's "the server MUST return a different SyncKey every
 * time" requirement) paired with the `dateModified` watermark that generation was issued at.
 */
export interface SyncKey {
    generation: number;
    watermark: Date;
}

/** Formats a `SyncKey` back into its wire string form. */
export function formatSyncKey(key: SyncKey): string {
    return `${key.generation}:${key.watermark.toISOString()}`;
}

/** Parses a stored/previously-issued `SyncKey` string. Returns `undefined` for a malformed value - callers
 * only ever parse a key this library itself minted and stored (never a raw, unvalidated client value; see
 * `resolveSyncKey`'s doc comment), so `undefined` here signals corrupted persisted state, not client input. */
export function parseSyncKey(value: string): SyncKey | undefined {
    const separator = value.indexOf(":");
    if (separator === -1) {
        return undefined;
    }
    const generation = Number(value.slice(0, separator));
    const watermark = new Date(value.slice(separator + 1));
    if (!Number.isFinite(generation) || Number.isNaN(watermark.getTime())) {
        return undefined;
    }
    return { generation, watermark };
}

export type SyncKeyResolution =
    | { kind: "initial" }
    | { kind: "valid"; key: SyncKey }
    | { kind: "invalid" };

/**
 * Resolves an incoming client `SyncKey` string against the value this library itself previously issued and
 * stored (`storedValue`, e.g. `DeviceSyncState.folderSyncKeys[folderUid]`) — deliberately a plain string
 * equality check, not a re-parse-and-compare of the client's value, so a client that echoes back anything
 * other than the exact opaque string it was handed is treated as `"invalid"` even if it happens to parse.
 *
 * - `"0"` (or empty/missing) from the client is always `"initial"` regardless of `storedValue` — an EAS
 * client legitimately sends this to (re)start a collection from scratch (first-ever sync, or recovering
 * from an `"invalid"` response elsewhere), and the spec requires the server honor it unconditionally.
 * - Otherwise, a match against `storedValue` is `"valid"`; anything else (including `storedValue` being
 * unset, i.e. the server has no record of ever issuing a key for this scope) is `"invalid"` — forcing the
 * client back to `"0"`, per spec, rather than guessing at recovery.
 */
export function resolveSyncKey(clientValue: string | undefined, storedValue: string | undefined): SyncKeyResolution {
    if (!clientValue || clientValue === "0") {
        return { kind: "initial" };
    }
    if (storedValue === undefined || clientValue !== storedValue) {
        return { kind: "invalid" };
    }
    const parsed = parseSyncKey(storedValue);
    return parsed ? { kind: "valid", key: parsed } : { kind: "invalid" };
}

/** One page of enumerated changes for a `RecoverableBaseEntity` collection scoped by a single field (e.g.
 * `folderUid` for `Message`/`CalendarEvent`/.../`mailboxUid` for `Folder`), since the last sync at `watermark`. */
export interface ChangeSet<T extends RecoverableBaseEntity> {
    adds: T[];
    changes: T[];
    deletes: T[];
    /** The new watermark to persist as this generation's cursor - the latest `dateModified` actually included
     * in this page, never simply "now" (which would silently skip any row modified after this page was read
     * but before the caller finishes processing it). Equal to the input `watermark` when nothing changed. */
    newWatermark: Date;
    /** `true` when more changed rows exist beyond `windowSize` - the caller should set the response's
     * `MoreAvailable` flag so the client immediately re-syncs for the rest, rather than waiting a full poll
     * interval. */
    moreAvailable: boolean;
}

/** A tolerance window for treating a row's `dateCreated`/`dateModified` as "close enough" to be an `Add`
 * rather than a `Change` - the two are set within the same request handler and so are typically only
 * milliseconds apart, never exactly equal down to the microsecond depending on the datastore's clock
 * resolution. */
const NEWLY_CREATED_TOLERANCE_MS = 1000;

/**
 * Enumerates `Add`/`Change`/`Delete`s for one scoped collection since `watermark`, for `FolderSyncCommand` and
 * (eventually) `SyncCommand`'s shared cursor mechanism. Requires `T` to be `RecoverableBaseEntity` (soft
 * delete) — see `RecoverableRepoUtils`'s own doc comment for why a plain hard-deleted entity can't support
 * this at all (nothing left to enumerate once a row is actually gone).
 *
 * `RepoUtils.find()` does **not** support an `includeDeleted` option - confirmed by reading its source: unlike
 * `count()`/`findOne()`, it never strips `ModelUtils.buildSearchQuery()`'s default `deleted: false` exclusion
 * back out. Rather than the (harmless-looking but silently no-op) `includeDeleted: true` this function used to
 * pass, deleted rows are fetched via a **second** `find()` call with an explicit, literal `deleted: true` in
 * the query object itself - `buildSearchQuery()`'s exclusion only applies when the caller's query has no
 * `"deleted"` key at all, so supplying one directly (rather than relying on an option `find()` doesn't honor)
 * reliably selects exactly the soft-deleted rows instead. The two result sets are then merged and re-windowed
 * together so `windowSize`/`MoreAvailable` still describe the combined stream, not each half independently.
 */
export async function computeChanges<T extends RecoverableBaseEntity>(
    repo: RepoUtils<T>,
    scopeField: string,
    scopeUid: string,
    watermark: Date,
    windowSize: number,
): Promise<ChangeSet<T>> {
    // Overfetch by one (per stream) so a full window can be distinguished from an exact-fit window without a
    // separate count() round trip - the same trick `ExternalShareExpirationJob`/`MailboxQuotaRecalcJob` already
    // use for their own MoreAvailable-shaped bookkeeping. `limit`/`sort` must be baked into the query object
    // itself (not just `options`) for the SQL backend - see those same jobs' comments on this exact requirement.
    const baseCriteria: any = { [scopeField]: scopeUid, dateModified: `gt(${watermark.toISOString()})` };
    const findOptions: any = { ignoreACL: true, limit: windowSize + 1, sort: "dateModified" };
    const [liveRows, deletedRows] = await Promise.all([
        repo.find({ ...baseCriteria, sort: "dateModified", limit: windowSize + 1 }, findOptions),
        repo.find({ ...baseCriteria, deleted: true, sort: "dateModified", limit: windowSize + 1 }, findOptions),
    ]);

    const merged: T[] = [...liveRows, ...deletedRows].sort(
        (a, b) => new Date((a as any).dateModified).getTime() - new Date((b as any).dateModified).getTime(),
    );

    const moreAvailable: boolean = merged.length > windowSize;
    const page: T[] = moreAvailable ? merged.slice(0, windowSize) : merged;

    const adds: T[] = [];
    const changes: T[] = [];
    const deletes: T[] = [];
    let newWatermark: Date = watermark;

    for (const row of page) {
        const dateModified = new Date((row as any).dateModified);
        if (dateModified.getTime() > newWatermark.getTime()) {
            newWatermark = dateModified;
        }

        if ((row as any).deleted === true) {
            deletes.push(row);
        } else {
            const dateCreated = new Date((row as any).dateCreated);
            const isNewlyCreated = Math.abs(dateModified.getTime() - dateCreated.getTime()) < NEWLY_CREATED_TOLERANCE_MS;
            (isNewlyCreated ? adds : changes).push(row);
        }
    }

    return { adds, changes, deletes, newWatermark, moreAvailable };
}
