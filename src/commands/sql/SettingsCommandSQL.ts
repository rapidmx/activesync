///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import { MailboxSQL } from "@rapidmx/restapi/sql";
import { SettingsCommand } from "../SettingsCommand.js";

/**
 * @author Jean-Philippe Steinmetz
 */
export class SettingsCommandSQL extends SettingsCommand {
    protected mailboxClass: any = MailboxSQL;
}
