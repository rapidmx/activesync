///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import { MessageMongo, AttachmentMongo } from "@rapidmx/restapi/mongo";
import { ItemOperationsCommand } from "../ItemOperationsCommand.js";

/**
 * @author Jean-Philippe Steinmetz
 */
export class ItemOperationsCommandMongo extends ItemOperationsCommand {
    protected messageClass: any = MessageMongo;
    protected attachmentClass: any = AttachmentMongo;
}
