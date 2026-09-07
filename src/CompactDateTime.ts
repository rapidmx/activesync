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
