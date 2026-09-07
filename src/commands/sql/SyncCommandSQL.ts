///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import { MessageSQL, ContactSQL, CalendarEventSQL, TaskSQL, MailboxSQL } from "@rapidmx/restapi/sql";
import { EmailSyncAdapter } from "../../adapters/EmailSyncAdapter.js";
import { ContactsSyncAdapter } from "../../adapters/ContactsSyncAdapter.js";
import { CalendarSyncAdapter } from "../../adapters/CalendarSyncAdapter.js";
import { TasksSyncAdapter } from "../../adapters/TasksSyncAdapter.js";
import { SyncCommand, type SyncCollectionBinding } from "../SyncCommand.js";

/**
 * @author Jean-Philippe Steinmetz
 */
export class SyncCommandSQL extends SyncCommand {
    protected mailboxClass: any = MailboxSQL;
    protected collectionBindings: Record<string, SyncCollectionBinding<any>> = {
        Email: { entityClass: MessageSQL, adapterClass: EmailSyncAdapter },
        Contacts: { entityClass: ContactSQL, adapterClass: ContactsSyncAdapter },
        Calendar: { entityClass: CalendarEventSQL, adapterClass: CalendarSyncAdapter },
        Tasks: { entityClass: TaskSQL, adapterClass: TasksSyncAdapter },
    };
}
