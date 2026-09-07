///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import { MessageMongo, FolderMongo } from "@rapidmx/restapi/mongo";
import { MoveItemsCommand } from "../MoveItemsCommand.js";

/**
 * @author Jean-Philippe Steinmetz
 */
export class MoveItemsCommandMongo extends MoveItemsCommand {
    protected messageClass: any = MessageMongo;
    protected folderClass: any = FolderMongo;
}
