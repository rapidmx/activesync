///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import { ComposeMailCommand } from "./ComposeMailCommand.js";

/**
 * Handles EAS `SendMail`: relays a freshly composed message with no referenced original - see
 * `ComposeMailCommand`'s own doc comment for the full shared implementation.
 *
 * @author Jean-Philippe Steinmetz
 */
export abstract class SendMailCommand extends ComposeMailCommand {
    public readonly command = "SendMail";
}
