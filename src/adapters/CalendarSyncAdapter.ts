///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import * as crypto from "crypto";
import { WbxmlCodePage } from "../codec/WbxmlCodePages.js";
import { childText, element, findChild, textElement, type WbxmlElement } from "../codec/WbxmlElement.js";
import { fromCompactDateTime, toCompactDateTime } from "../CompactDateTime.js";
import type { EasCollectionSyncAdapter } from "./EasCollectionSyncAdapter.js";
import {
    AttendeeResponseStatus,
    AttendeeRole,
    BusyStatus,
    type CalendarEvent,
    type RecurrenceRule,
    RecurrenceFrequency,
    RecipientType,
    type Attendee,
} from "@rapidmx/restapi";

/** Builds the reverse of a forward code-table once at module load, rather than re-deriving it per call. */
function invert<K extends string>(table: Record<K, string>): Record<string, K> {
    return Object.fromEntries(Object.entries(table).map(([k, v]) => [v, k])) as Record<string, K>;
}

/** MS-ASCAL `BusyStatus`: 0=Free, 1=Tentative, 2=Busy, 3=Out of Office. Confirmed against the published
 * MS-ASCAL spec, not assumed - note the value order does not match this library's own `BusyStatus` enum
 * declaration order, so an identity/positional mapping would have been silently wrong. */
const BUSY_STATUS_CODES: Record<BusyStatus, string> = {
    [BusyStatus.FREE]: "0",
    [BusyStatus.TENTATIVE]: "1",
    [BusyStatus.BUSY]: "2",
    [BusyStatus.OUT_OF_OFFICE]: "3",
};

/** MS-ASCAL `AttendeeStatus`: 0=Response unknown, 2=Tentative, 3=Accept, 4=Decline, 5=Not responded. This
 * library's own `AttendeeResponseStatus.NEEDS_ACTION` maps to 0 (unknown) rather than 5 (not responded) - both
 * are defensible for "no response yet", and 0 is the spec's own documented fallback/default value. */
const ATTENDEE_STATUS_CODES: Record<AttendeeResponseStatus, string> = {
    [AttendeeResponseStatus.NEEDS_ACTION]: "0",
    [AttendeeResponseStatus.TENTATIVE]: "2",
    [AttendeeResponseStatus.ACCEPTED]: "3",
    [AttendeeResponseStatus.DECLINED]: "4",
};

/** MS-ASCAL `AttendeeType`: 1=Required, 2=Optional, 3=Resource. */
const ATTENDEE_TYPE_CODES: Record<AttendeeRole, string> = {
    [AttendeeRole.REQUIRED]: "1",
    [AttendeeRole.OPTIONAL]: "2",
    [AttendeeRole.RESOURCE]: "3",
};

/** MS-ASCAL `Recurrence.Type`: 0=Daily, 1=Weekly, 2=Monthly, 5=Yearly (3="monthly on the nth day" and
 * 6="yearly on the nth day" - patterns keyed by an ordinal weekday, e.g. "the 2nd Tuesday" - are a documented,
 * out-of-scope gap for this pragmatic subset; `RecurrenceRule` has no ordinal-weekday field to source them
 * from anyway, only plain day-of-month/day-of-week lists). */
const RECURRENCE_TYPE_CODES: Record<RecurrenceFrequency, string> = {
    [RecurrenceFrequency.DAILY]: "0",
    [RecurrenceFrequency.WEEKLY]: "1",
    [RecurrenceFrequency.MONTHLY]: "2",
    [RecurrenceFrequency.YEARLY]: "5",
};

/** MS-ASCAL `DayOfWeek` bitmask: Sunday=1, Monday=2, Tuesday=4, Wednesday=8, Thursday=16, Friday=32,
 * Saturday=64 - summed when a recurrence applies to more than one day. `RecurrenceRule.byDay` uses RFC 5545's
 * two-letter day codes. */
const DAY_OF_WEEK_BITS: Record<string, number> = { SU: 1, MO: 2, TU: 4, WE: 8, TH: 16, FR: 32, SA: 64 };

const BUSY_STATUS_FROM_CODE = invert(BUSY_STATUS_CODES);
const ATTENDEE_STATUS_FROM_CODE = invert(ATTENDEE_STATUS_CODES);
const ATTENDEE_TYPE_FROM_CODE = invert(ATTENDEE_TYPE_CODES);
const RECURRENCE_FREQUENCY_FROM_CODE = invert(RECURRENCE_TYPE_CODES);

/**
 * Maps `CalendarEvent` to/from the EAS `Sync` `Calendar` collection class (MS-ASCAL).
 *
 * **Pragmatic subset, deliberately not the full MS-ASCAL semantics**:
 * - `TimeZone` is not emitted - the real element is a base64-encoded binary Win32 `TIME_ZONE_INFORMATION`
 * structure, not a plain IANA string; `CalendarEvent.timezone` (an IANA identifier) can't be losslessly
 * re-encoded into that format without a full IANA-to-Windows zone mapping table, and a real device would
 * rather see no `TimeZone` element (falling back to its own default) than a malformed one.
 * - `Sensitivity` is always reported `0` (Normal) - this library's `CalendarEvent` has no privacy dimension of
 * its own to source a real value from.
 * - Recurrence patterns keyed by an ordinal weekday (MS-ASCAL `Type` 3/6, e.g. "the 2nd Tuesday of the month")
 * are not emitted - see `RECURRENCE_TYPE_CODES`'s own doc comment.
 * - Recurrence exceptions (individually modified/cancelled occurrences of a recurring series) are not synced -
 * deferred, matching this library's "pragmatic subset" precedent elsewhere (e.g. `FolderSyncCommand`'s SyncKey
 * replay-protection gap).
 *
 * @author Jean-Philippe Steinmetz
 */
export class CalendarSyncAdapter implements EasCollectionSyncAdapter<CalendarEvent> {
    public readonly collectionClass = "Calendar";

    public toApplicationData(event: CalendarEvent): WbxmlElement {
        const hasAttendees = event.attendees.length > 0;

        return element(WbxmlCodePage.AirSync, "ApplicationData", [
            textElement(WbxmlCodePage.Calendar, "Subject", event.title),
            ...(event.location ? [textElement(WbxmlCodePage.Calendar, "Location", event.location)] : []),
            textElement(WbxmlCodePage.Calendar, "StartTime", toCompactDateTime(event.startDate)),
            textElement(WbxmlCodePage.Calendar, "EndTime", toCompactDateTime(event.endDate)),
            textElement(WbxmlCodePage.Calendar, "AllDayEvent", event.allDay ? "1" : "0"),
            textElement(WbxmlCodePage.Calendar, "DtStamp", toCompactDateTime(event.dateModified)),
            textElement(WbxmlCodePage.Calendar, "BusyStatus", BUSY_STATUS_CODES[event.busyStatus]),
            textElement(WbxmlCodePage.Calendar, "Sensitivity", "0"),
            textElement(WbxmlCodePage.Calendar, "MeetingStatus", hasAttendees ? "1" : "0"),
            textElement(WbxmlCodePage.Calendar, "OrganizerEmail", event.organizer.address),
            ...(event.organizer.displayName
                ? [textElement(WbxmlCodePage.Calendar, "OrganizerName", event.organizer.displayName)]
                : []),
            ...(hasAttendees
                ? [
                      element(
                          WbxmlCodePage.Calendar,
                          "Attendees",
                          event.attendees.map((attendee) =>
                              element(WbxmlCodePage.Calendar, "Attendee", [
                                  textElement(WbxmlCodePage.Calendar, "Email", attendee.address),
                                  ...(attendee.displayName
                                      ? [textElement(WbxmlCodePage.Calendar, "Name", attendee.displayName)]
                                      : []),
                                  textElement(WbxmlCodePage.Calendar, "AttendeeType", ATTENDEE_TYPE_CODES[attendee.role]),
                                  textElement(WbxmlCodePage.Calendar, "AttendeeStatus", ATTENDEE_STATUS_CODES[attendee.responseStatus]),
                              ]),
                          ),
                      ),
                  ]
                : []),
            // `!= null` (not `!== undefined`) deliberately - TypeORM hydrates an unset nullable SQL column as
            // `null`, not `undefined` (confirmed by a real test failure against the SQL backend: `undefined`
            // survives a Mongo round-trip for a genuinely-absent field, but SQL hands back `null` instead, and
            // a strict `!== undefined` check would then wrongly treat that "absent" value as present).
            ...(event.reminderMinutesBeforeStart != null
                ? [textElement(WbxmlCodePage.Calendar, "Reminder", String(event.reminderMinutesBeforeStart))]
                : []),
            ...(event.recurrenceRule ? [this.recurrenceElement(event.recurrenceRule, event.startDate)] : []),
        ]);
    }

    private recurrenceElement(rule: RecurrenceRule, startDate: Date): WbxmlElement {
        const dayOfWeekBits = (rule.byDay ?? []).reduce((sum, day) => sum + (DAY_OF_WEEK_BITS[day] ?? 0), 0);

        return element(WbxmlCodePage.Calendar, "Recurrence", [
            textElement(WbxmlCodePage.Calendar, "Type", RECURRENCE_TYPE_CODES[rule.freq]),
            textElement(WbxmlCodePage.Calendar, "Interval", String(rule.interval)),
            ...(rule.freq === RecurrenceFrequency.WEEKLY && dayOfWeekBits > 0
                ? [textElement(WbxmlCodePage.Calendar, "DayOfWeek", String(dayOfWeekBits))]
                : []),
            ...(rule.freq === RecurrenceFrequency.MONTHLY || rule.freq === RecurrenceFrequency.YEARLY
                ? [textElement(WbxmlCodePage.Calendar, "DayOfMonth", String(rule.byMonthDay?.[0] ?? startDate.getUTCDate()))]
                : []),
            ...(rule.freq === RecurrenceFrequency.YEARLY
                ? [textElement(WbxmlCodePage.Calendar, "MonthOfYear", String(rule.byMonth?.[0] ?? startDate.getUTCMonth() + 1))]
                : []),
            ...(rule.until ? [textElement(WbxmlCodePage.Calendar, "Until", toCompactDateTime(rule.until))] : []),
            // See the identical `!= null` reasoning on `reminderMinutesBeforeStart` above.
            ...(rule.count != null ? [textElement(WbxmlCodePage.Calendar, "Occurrences", String(rule.count))] : []),
        ]);
    }

    /**
     * Reverse of `toApplicationData`. `timezone`/`status`/`sequence`/`icalUid` have no wire representation at
     * all (see this class's own "pragmatic subset" doc comment for `timezone`; the other three are purely
     * server-managed identifiers/state a client was never sent in the first place) and are never included in
     * the returned partial - `newEntityDefaults()` below supplies `icalUid`/`sequence` for a brand new event
     * (`status`/`timezone` are left at the model's own constructor defaults), and `applyChange` leaves all four
     * untouched by construction (merging onto `existing`).
     *
     * `OrganizerEmail` is required for a new event (there is nowhere else to default it from - this adapter
     * has no mailbox context of its own) - a real calendar client always sends it regardless, since it already
     * knows its own account's address. Omitting it on an `Add` throws, which `SyncCommand.applyAdd` turns into
     * Status `6` ("client has sent a malformed or invalid item"), the spec's own designated code for exactly
     * this case.
     *
     * `Attendees`/`Recurrence` are ghosted as a whole element, like `ContactsSyncAdapter`'s arrays: present at
     * all -> rebuilt entirely from what's there; absent -> left untouched on a `Change`.
     */
    public fromApplicationData(el: WbxmlElement): Partial<CalendarEvent> {
        const partial: Partial<CalendarEvent> = {};

        const subject = childText(el, "Subject");
        if (subject !== undefined) partial.title = subject;
        const location = childText(el, "Location");
        if (location !== undefined) partial.location = location;
        const startTime = childText(el, "StartTime");
        if (startTime !== undefined) partial.startDate = fromCompactDateTime(startTime);
        const endTime = childText(el, "EndTime");
        if (endTime !== undefined) partial.endDate = fromCompactDateTime(endTime);
        const allDayEvent = childText(el, "AllDayEvent");
        if (allDayEvent !== undefined) partial.allDay = allDayEvent === "1";
        const busyStatus = childText(el, "BusyStatus");
        if (busyStatus !== undefined) {
            const mapped = BUSY_STATUS_FROM_CODE[busyStatus];
            if (!mapped) {
                throw new Error(`Unrecognized BusyStatus value: '${busyStatus}'`);
            }
            partial.busyStatus = mapped;
        }

        const organizerEmail = childText(el, "OrganizerEmail");
        if (organizerEmail !== undefined) {
            partial.organizer = {
                address: organizerEmail,
                displayName: childText(el, "OrganizerName"),
                type: RecipientType.TO,
            };
        }

        const reminder = childText(el, "Reminder");
        if (reminder !== undefined) partial.reminderMinutesBeforeStart = Number(reminder);

        const attendeesEl = findChild(el, "Attendees");
        if (attendeesEl) {
            partial.attendees = attendeesEl.children
                .filter((child) => child.tag === "Attendee")
                .map((attendeeEl) => this.attendeeFromElement(attendeeEl));
        }

        const recurrenceEl = findChild(el, "Recurrence");
        if (recurrenceEl) {
            partial.recurrenceRule = this.recurrenceRuleFromElement(recurrenceEl);
        }

        return partial;
    }

    /** `icalUid`/`sequence` have no wire representation on `Add` (see `fromApplicationData`'s own doc comment)
     * - without this, every Sync-created event would fall back to `CalendarEventMongo`/`CalendarEventSQL`'s own
     * constructor default of `icalUid: ""`, violating RFC 5545's uniqueness expectation for `UID`. Mirrors
     * MAPI's identical `RopSaveChangesMessageHandler` pattern (`${crypto.randomUUID()}@mapi`), `@eas` suffix
     * instead. */
    public newEntityDefaults(): Partial<CalendarEvent> {
        return { icalUid: `${crypto.randomUUID()}@eas`, sequence: 0 };
    }

    private attendeeFromElement(el: WbxmlElement): Attendee {
        const address = childText(el, "Email");
        if (!address) {
            throw new Error("Attendee element is missing its required Email child.");
        }
        const attendeeType = childText(el, "AttendeeType");
        const attendeeStatus = childText(el, "AttendeeStatus");
        return {
            address,
            displayName: childText(el, "Name"),
            role: (attendeeType && ATTENDEE_TYPE_FROM_CODE[attendeeType]) || AttendeeRole.REQUIRED,
            responseStatus: (attendeeStatus && ATTENDEE_STATUS_FROM_CODE[attendeeStatus]) || AttendeeResponseStatus.NEEDS_ACTION,
            isOrganizer: false,
        };
    }

    private recurrenceRuleFromElement(el: WbxmlElement): RecurrenceRule {
        const type = childText(el, "Type");
        const freq = type && RECURRENCE_FREQUENCY_FROM_CODE[type];
        if (!freq) {
            throw new Error(`Unrecognized or unsupported Recurrence Type value: '${type}'`);
        }
        const interval = childText(el, "Interval");
        const dayOfWeek = childText(el, "DayOfWeek");
        const dayOfMonth = childText(el, "DayOfMonth");
        const monthOfYear = childText(el, "MonthOfYear");
        const until = childText(el, "Until");
        const occurrences = childText(el, "Occurrences");

        const byDay: string[] = [];
        if (dayOfWeek !== undefined) {
            const bits = Number(dayOfWeek);
            for (const [code, bit] of Object.entries(DAY_OF_WEEK_BITS)) {
                if ((bits & bit) !== 0) byDay.push(code);
            }
        }

        return {
            freq,
            interval: interval !== undefined ? Number(interval) : 1,
            ...(byDay.length > 0 ? { byDay } : {}),
            ...(dayOfMonth !== undefined ? { byMonthDay: [Number(dayOfMonth)] } : {}),
            ...(monthOfYear !== undefined ? { byMonth: [Number(monthOfYear)] } : {}),
            ...(until !== undefined ? { until: fromCompactDateTime(until) } : {}),
            ...(occurrences !== undefined ? { count: Number(occurrences) } : {}),
            exceptions: [],
        };
    }
}
