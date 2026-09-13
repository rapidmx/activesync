///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import { ContactSQL, MessageSQL } from "@rapidmx/restapi/sql";
import { EmailSyncAdapterSQL } from "../../adapters/sql/EmailSyncAdapterSQL.js";
import { SearchCommand } from "../SearchCommand.js";

/**
 * @author Jean-Philippe Steinmetz
 */
export class SearchCommandSQL extends SearchCommand {
    protected contactClass: any = ContactSQL;
    protected messageClass: any = MessageSQL;
    protected emailAdapterClass: any = EmailSyncAdapterSQL;
}
