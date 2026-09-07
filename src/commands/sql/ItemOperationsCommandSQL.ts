///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import { MessageSQL, AttachmentSQL, FolderSQL } from "@rapidmx/restapi/sql";
import { ItemOperationsCommand } from "../ItemOperationsCommand.js";

/**
 * @author Jean-Philippe Steinmetz
 */
export class ItemOperationsCommandSQL extends ItemOperationsCommand {
    protected folderClass: any = FolderSQL;
    protected messageClass: any = MessageSQL;
    protected attachmentClass: any = AttachmentSQL;
}
