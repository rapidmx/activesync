///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import { FolderMongo } from "@rapidmx/restapi/mongo";
import { FolderSyncCommand } from "../FolderSyncCommand.js";

/**
 * @author Jean-Philippe Steinmetz
 */
export class FolderSyncCommandMongo extends FolderSyncCommand<FolderMongo> {
    protected folderClass: any = FolderMongo;
}
