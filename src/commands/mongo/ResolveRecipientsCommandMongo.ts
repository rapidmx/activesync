///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import { ContactMongo } from "@rapidmx/restapi/mongo";
import { ResolveRecipientsCommand } from "../ResolveRecipientsCommand.js";

/**
 * @author Jean-Philippe Steinmetz
 */
export class ResolveRecipientsCommandMongo extends ResolveRecipientsCommand {
    protected contactClass: any = ContactMongo;

    protected likePattern(escaped: string): string {
        // Mongo's like() compiles to an unanchored $regex - already a substring match with no wrapping needed.
        return escaped;
    }
}
