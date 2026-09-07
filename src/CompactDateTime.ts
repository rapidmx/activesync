///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////

/**
 * Formats a date as MS-ASDTYPE's "Compact DateTime" (`YYYYMMDDTHHMMSSZ`, always UTC) - the format
 * `Calendar`/`Tasks` timestamp fields (`StartTime`/`EndTime`/`UtcDueDate`/...) use, distinct from the plain
 * `dateTime` type (`YYYY-MM-DDTHH:MM:SS.MSSZ`, i.e. `Date.prototype.toISOString()`) `Email`'s `DateReceived`
 * uses - confirmed against the published MS-ASDTYPE spec (`2.7.2 Compact DateTime` vs `2.7 dateTime Data
 * Type`), not assumed, since sending the wrong one is exactly the kind of silent-until-a-real-device-connects
 * bug this library's WBXML codec work already ran into once with tag casing (`"Mime"` vs `"MIME"`).
 *
 * Accepts `Date | string` and normalizes via `new Date(...)` - a real, discovered-by-testing gap: fields
 * embedded inside a `simple-json` column (e.g. `RecurrenceRule.until`) round-trip through `JSON.stringify`/
 * `JSON.parse` on the SQL backend, which does not preserve `Date` instances, so `until` comes back as a plain
 * ISO string there even though the Mongo backend (native BSON dates) hands back a real `Date` for the exact
 * same field - a caller passing either must work on both backends without knowing which one it's talking to.
 */
export function toCompactDateTime(date: Date | string): string {
    const d = date instanceof Date ? date : new Date(date);
    const pad = (n: number): string => String(n).padStart(2, "0");
    return (
        `${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}` +
        `T${pad(d.getUTCHours())}${pad(d.getUTCMinutes())}${pad(d.getUTCSeconds())}Z`
    );
}

/** Anchored strictly to `toCompactDateTime`'s own output shape (`YYYYMMDDTHHMMSSZ`) - a client sending
 * anything else has sent a malformed item, which the caller (an `EasCollectionSyncAdapter.fromApplicationData`
 * implementation) should treat as `Status 6` rather than silently guessing. */
const COMPACT_DATE_TIME_PATTERN = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z$/;

/**
 * Parses MS-ASDTYPE's "Compact DateTime" (`YYYYMMDDTHHMMSSZ`) back into a `Date` - the reverse of
 * `toCompactDateTime`, needed for `Sync`'s client-originated `Add`/`Change` commands on `Calendar`/`Tasks`.
 * Throws (rather than returning an unvalidated `Date` that would silently carry `NaN`s) for anything not
 * matching the exact expected shape.
 */
export function fromCompactDateTime(value: string): Date {
    const match = COMPACT_DATE_TIME_PATTERN.exec(value);
    if (!match) {
        throw new Error(`Not a valid Compact DateTime value: '${value}'`);
    }
    const [, year, month, day, hour, minute, second] = match;
    return new Date(
        Date.UTC(Number(year), Number(month) - 1, Number(day), Number(hour), Number(minute), Number(second)),
    );
}
