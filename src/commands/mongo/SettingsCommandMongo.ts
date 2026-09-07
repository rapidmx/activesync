///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import { MailboxMongo } from "@rapidmx/restapi/mongo";
import { SettingsCommand } from "../SettingsCommand.js";

/**
 * @author Jean-Philippe Steinmetz
 */
export class SettingsCommandMongo extends SettingsCommand {
    protected mailboxClass: any = MailboxMongo;
}
