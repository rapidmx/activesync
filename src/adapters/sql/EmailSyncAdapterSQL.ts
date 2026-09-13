///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import { LabelSQL } from "@rapidmx/restapi/sql";
import { EmailSyncAdapter } from "../EmailSyncAdapter.js";

/**
 * @author Jean-Philippe Steinmetz
 */
export class EmailSyncAdapterSQL extends EmailSyncAdapter {
    protected labelClass: any = LabelSQL;
}
