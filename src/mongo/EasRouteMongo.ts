///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import { DeviceSyncStateMongo, MailboxMongo } from "@rapidmx/restapi/mongo";
import { BaseEasRoute } from "../BaseEasRoute.js";
import { ProvisionCommand } from "../commands/ProvisionCommand.js";
import { PingCommand } from "../commands/PingCommand.js";
import { FolderSyncCommandMongo } from "../commands/mongo/FolderSyncCommandMongo.js";
import { SyncCommandMongo } from "../commands/mongo/SyncCommandMongo.js";
import { SendMailCommandMongo } from "../commands/mongo/SendMailCommandMongo.js";
import { SmartForwardCommandMongo } from "../commands/mongo/SmartForwardCommandMongo.js";
import { SmartReplyCommandMongo } from "../commands/mongo/SmartReplyCommandMongo.js";
import { ItemOperationsCommandMongo } from "../commands/mongo/ItemOperationsCommandMongo.js";
import { SearchCommandMongo } from "../commands/mongo/SearchCommandMongo.js";
import { MeetingResponseCommandMongo } from "../commands/mongo/MeetingResponseCommandMongo.js";
import { SettingsCommandMongo } from "../commands/mongo/SettingsCommandMongo.js";
import { GetItemEstimateCommandMongo } from "../commands/mongo/GetItemEstimateCommandMongo.js";
import { MoveItemsCommandMongo } from "../commands/mongo/MoveItemsCommandMongo.js";
import { ResolveRecipientsCommandMongo } from "../commands/mongo/ResolveRecipientsCommandMongo.js";

/**
 * Mongo-backed concrete `BaseEasRoute`. A deployment mounts this at the well-known EAS path via its own
 * trivial `@Route("/Microsoft-Server-ActiveSync")` subclass, following the same pattern
 * `push/MailPushRoute.ts`'s doc comment describes for `BasePushRoute`.
 *
 * @author Jean-Philippe Steinmetz
 */
export class EasRouteMongo extends BaseEasRoute<DeviceSyncStateMongo, MailboxMongo> {
    protected deviceSyncStateClass: any = DeviceSyncStateMongo;
    protected mailboxClass: any = MailboxMongo;
    protected commandHandlerClasses: any[] = [
        ProvisionCommand,
        FolderSyncCommandMongo,
        SyncCommandMongo,
        SendMailCommandMongo,
        SmartForwardCommandMongo,
        SmartReplyCommandMongo,
        ItemOperationsCommandMongo,
        SearchCommandMongo,
        MeetingResponseCommandMongo,
        SettingsCommandMongo,
        PingCommand,
        GetItemEstimateCommandMongo,
        MoveItemsCommandMongo,
        ResolveRecipientsCommandMongo,
    ];
}
