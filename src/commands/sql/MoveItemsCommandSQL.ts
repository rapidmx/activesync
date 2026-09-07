///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import { MessageSQL, FolderSQL } from "@rapidmx/restapi/sql";
import { MoveItemsCommand } from "../MoveItemsCommand.js";

/**
 * @author Jean-Philippe Steinmetz
 */
export class MoveItemsCommandSQL extends MoveItemsCommand {
    protected messageClass: any = MessageSQL;
    protected folderClass: any = FolderSQL;
}
