///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import { CalendarEventSQL, MailboxSQL } from "@rapidmx/restapi/sql";
import { MeetingResponseCommand } from "../MeetingResponseCommand.js";

/**
 * @author Jean-Philippe Steinmetz
 */
export class MeetingResponseCommandSQL extends MeetingResponseCommand {
    protected calendarEventClass: any = CalendarEventSQL;
    protected mailboxClass: any = MailboxSQL;
}
