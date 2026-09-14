///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import { FolderSQL, MailboxSQL, MessageSQL } from "@rapidmx/restapi/sql";
import { SmartReplyCommand } from "../SmartReplyCommand.js";

/**
 * @author Jean-Philippe Steinmetz
 */
export class SmartReplyCommandSQL extends SmartReplyCommand {
    protected folderClass: any = FolderSQL;
    protected messageClass: any = MessageSQL;
    protected mailboxClass: any = MailboxSQL;
}
