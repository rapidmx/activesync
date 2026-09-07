///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import { DeviceSyncStateSQL, MailboxSQL } from "@rapidmx/restapi/sql";
import { BaseEasRoute } from "../BaseEasRoute.js";
import { ProvisionCommand } from "../commands/ProvisionCommand.js";
import { PingCommand } from "../commands/PingCommand.js";
import { FolderSyncCommandSQL } from "../commands/sql/FolderSyncCommandSQL.js";
import { SyncCommandSQL } from "../commands/sql/SyncCommandSQL.js";
import { SendMailCommandSQL } from "../commands/sql/SendMailCommandSQL.js";
import { SmartForwardCommandSQL } from "../commands/sql/SmartForwardCommandSQL.js";
import { SmartReplyCommandSQL } from "../commands/sql/SmartReplyCommandSQL.js";
import { ItemOperationsCommandSQL } from "../commands/sql/ItemOperationsCommandSQL.js";
import { SearchCommandSQL } from "../commands/sql/SearchCommandSQL.js";
import { MeetingResponseCommandSQL } from "../commands/sql/MeetingResponseCommandSQL.js";
import { SettingsCommandSQL } from "../commands/sql/SettingsCommandSQL.js";
import { GetItemEstimateCommandSQL } from "../commands/sql/GetItemEstimateCommandSQL.js";
import { MoveItemsCommandSQL } from "../commands/sql/MoveItemsCommandSQL.js";
import { ResolveRecipientsCommandSQL } from "../commands/sql/ResolveRecipientsCommandSQL.js";

/**
 * SQL-backed concrete `BaseEasRoute`. See `EasRouteMongo.ts`'s doc comment - the same mounting pattern
 * applies here.
 *
 * @author Jean-Philippe Steinmetz
 */
export class EasRouteSQL extends BaseEasRoute<DeviceSyncStateSQL, MailboxSQL> {
    protected deviceSyncStateClass: any = DeviceSyncStateSQL;
    protected mailboxClass: any = MailboxSQL;
    protected commandHandlerClasses: any[] = [
        ProvisionCommand,
        FolderSyncCommandSQL,
        SyncCommandSQL,
        SendMailCommandSQL,
        SmartForwardCommandSQL,
        SmartReplyCommandSQL,
        ItemOperationsCommandSQL,
        SearchCommandSQL,
        MeetingResponseCommandSQL,
        SettingsCommandSQL,
        PingCommand,
        GetItemEstimateCommandSQL,
        MoveItemsCommandSQL,
        ResolveRecipientsCommandSQL,
    ];
}
