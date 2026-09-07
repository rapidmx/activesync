///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import { FolderSQL, MessageSQL } from "@rapidmx/restapi/sql";
import { SmartForwardCommand } from "../SmartForwardCommand.js";

/**
 * @author Jean-Philippe Steinmetz
 */
export class SmartForwardCommandSQL extends SmartForwardCommand {
    protected folderClass: any = FolderSQL;
    protected messageClass: any = MessageSQL;
}
