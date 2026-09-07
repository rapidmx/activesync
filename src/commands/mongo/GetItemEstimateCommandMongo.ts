///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import { MessageMongo, ContactMongo, CalendarEventMongo, TaskMongo } from "@rapidmx/restapi/mongo";
import { GetItemEstimateCommand, type EstimateCollectionBinding } from "../GetItemEstimateCommand.js";

/**
 * @author Jean-Philippe Steinmetz
 */
export class GetItemEstimateCommandMongo extends GetItemEstimateCommand {
    protected collectionBindings: Record<string, EstimateCollectionBinding> = {
        Email: { entityClass: MessageMongo },
        Contacts: { entityClass: ContactMongo },
        Calendar: { entityClass: CalendarEventMongo },
        Tasks: { entityClass: TaskMongo },
    };
}
