///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import { MessageMongo, ContactMongo, CalendarEventMongo, TaskMongo } from "@rapidmx/restapi/mongo";
import { EasCollectionStateMongo } from "../../models/mongo/EasCollectionStateMongo.js";
import { PingCommand, type PingCollectionBinding } from "../PingCommand.js";

/**
 * @author Jean-Philippe Steinmetz
 */
export class PingCommandMongo extends PingCommand {
    protected collectionStateClass: any = EasCollectionStateMongo;
    protected collectionBindings: Record<string, PingCollectionBinding> = {
        Email: { entityClass: MessageMongo },
        Contacts: { entityClass: ContactMongo },
        Calendar: { entityClass: CalendarEventMongo },
        Tasks: { entityClass: TaskMongo },
    };
}
