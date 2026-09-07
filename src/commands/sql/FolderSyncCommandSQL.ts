///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import { FolderSQL } from "@rapidmx/restapi/sql";
import { FolderSyncCommand } from "../FolderSyncCommand.js";

/**
 * @author Jean-Philippe Steinmetz
 */
export class FolderSyncCommandSQL extends FolderSyncCommand<FolderSQL> {
    protected folderClass: any = FolderSQL;
}
