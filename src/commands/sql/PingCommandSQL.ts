///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import { MessageSQL, ContactSQL, CalendarEventSQL, TaskSQL } from "@rapidmx/restapi/sql";
import { EasCollectionStateSQL } from "../../models/sql/EasCollectionStateSQL.js";
import { PingCommand, type PingCollectionBinding } from "../PingCommand.js";

/**
 * @author Jean-Philippe Steinmetz
 */
export class PingCommandSQL extends PingCommand {
    protected collectionStateClass: any = EasCollectionStateSQL;
    protected collectionBindings: Record<string, PingCollectionBinding> = {
        Email: { entityClass: MessageSQL },
        Contacts: { entityClass: ContactSQL },
        Calendar: { entityClass: CalendarEventSQL },
        Tasks: { entityClass: TaskSQL },
    };
}
