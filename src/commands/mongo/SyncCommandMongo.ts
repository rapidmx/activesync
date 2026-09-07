///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import { MessageMongo, ContactMongo, CalendarEventMongo, TaskMongo, MailboxMongo } from "@rapidmx/restapi/mongo";
import { EmailSyncAdapter } from "../../adapters/EmailSyncAdapter.js";
import { ContactsSyncAdapter } from "../../adapters/ContactsSyncAdapter.js";
import { CalendarSyncAdapter } from "../../adapters/CalendarSyncAdapter.js";
import { TasksSyncAdapter } from "../../adapters/TasksSyncAdapter.js";
import { SyncCommand, type SyncCollectionBinding } from "../SyncCommand.js";

/**
 * @author Jean-Philippe Steinmetz
 */
export class SyncCommandMongo extends SyncCommand {
    protected mailboxClass: any = MailboxMongo;
    protected collectionBindings: Record<string, SyncCollectionBinding<any>> = {
        Email: { entityClass: MessageMongo, adapterClass: EmailSyncAdapter },
        Contacts: { entityClass: ContactMongo, adapterClass: ContactsSyncAdapter },
        Calendar: { entityClass: CalendarEventMongo, adapterClass: CalendarSyncAdapter },
        Tasks: { entityClass: TaskMongo, adapterClass: TasksSyncAdapter },
    };
}
