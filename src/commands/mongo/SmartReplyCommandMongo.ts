///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import { FolderMongo, MessageMongo } from "@rapidmx/restapi/mongo";
import { SmartReplyCommand } from "../SmartReplyCommand.js";

/**
 * @author Jean-Philippe Steinmetz
 */
export class SmartReplyCommandMongo extends SmartReplyCommand {
    protected folderClass: any = FolderMongo;
    protected messageClass: any = MessageMongo;
}
