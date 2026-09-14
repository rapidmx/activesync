///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import { MessageSQL, ContactSQL, CalendarEventSQL, TaskSQL, FolderSQL } from "@rapidmx/restapi/sql";
import { EasCollectionStateSQL } from "../../models/sql/EasCollectionStateSQL.js";
import { GetItemEstimateCommand, type EstimateCollectionBinding } from "../GetItemEstimateCommand.js";

/**
 * @author Jean-Philippe Steinmetz
 */
export class GetItemEstimateCommandSQL extends GetItemEstimateCommand {
    protected folderClass: any = FolderSQL;
    protected collectionStateClass: any = EasCollectionStateSQL;
    protected collectionBindings: Record<string, EstimateCollectionBinding> = {
        Email: { entityClass: MessageSQL },
        Contacts: { entityClass: ContactSQL },
        Calendar: { entityClass: CalendarEventSQL },
        Tasks: { entityClass: TaskSQL },
    };
}
