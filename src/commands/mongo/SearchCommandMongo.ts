///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import { AuditLogEntryMongo, ContactMongo, MailboxMongo, MessageMongo } from "@rapidmx/restapi/mongo";
import { EmailSyncAdapterMongo } from "../../adapters/mongo/EmailSyncAdapterMongo.js";
import { SearchCommand } from "../SearchCommand.js";

/**
 * @author Jean-Philippe Steinmetz
 */
export class SearchCommandMongo extends SearchCommand {
    protected contactClass: any = ContactMongo;
    protected messageClass: any = MessageMongo;
    protected emailAdapterClass: any = EmailSyncAdapterMongo;
    protected mailboxClass: any = MailboxMongo;
    protected auditLogClass: any = AuditLogEntryMongo;
}
