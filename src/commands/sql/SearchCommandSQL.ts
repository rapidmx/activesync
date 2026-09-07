///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import { ContactSQL } from "@rapidmx/restapi/sql";
import { SearchCommand } from "../SearchCommand.js";

/**
 * @author Jean-Philippe Steinmetz
 */
export class SearchCommandSQL extends SearchCommand {
    protected contactClass: any = ContactSQL;

    protected likePattern(escaped: string): string {
        // SQL's like() compiles to TypeORM's ILike() - a plain LIKE, exact unless wrapped in % wildcards.
        return `%${escaped}%`;
    }
}
