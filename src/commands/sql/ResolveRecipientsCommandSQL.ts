///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import { ContactSQL } from "@rapidmx/restapi/sql";
import { ResolveRecipientsCommand } from "../ResolveRecipientsCommand.js";

/**
 * @author Jean-Philippe Steinmetz
 */
export class ResolveRecipientsCommandSQL extends ResolveRecipientsCommand {
    protected contactClass: any = ContactSQL;
}
