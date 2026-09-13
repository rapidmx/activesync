///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
// Smoke test for the `eas` barrel module (`@rapidrest/mail/eas`) - every other EAS test imports its subject
// directly from its concrete file (see e.g. test/eas/codec/WbxmlCodec.test.ts), so this file's only job is to
// catch a typo'd or missing `export *` in src/eas/index.ts itself: one representative, real symbol from each
// re-exported file, confirmed present and of the expected shape.
import * as Eas from "../src/index.js";

describe("eas/index Tests", () => {
    it("Re-exports the WBXML codec.", () => {
        expect(Eas.WbxmlCodePage.AirSync).toBe(0);
        expect(typeof Eas.WbxmlEncoder).toBe("function");
        expect(typeof Eas.WbxmlDecoder).toBe("function");
        expect(typeof Eas.element).toBe("function");
    });

    it("Re-exports the transport and command-dispatch base classes/types.", () => {
        expect(typeof Eas.BaseEasRoute).toBe("function");
        expect(typeof Eas.computeChanges).toBe("function");
        expect(typeof Eas.formatSyncKey).toBe("function");
        expect(typeof Eas.toCompactDateTime).toBe("function");
    });

    it("Re-exports every command's abstract base class.", () => {
        expect(typeof Eas.ProvisionCommand).toBe("function");
        expect(typeof Eas.FolderSyncCommand).toBe("function");
        expect(typeof Eas.SyncCommand).toBe("function");
        expect(typeof Eas.ComposeMailCommand).toBe("function");
        expect(typeof Eas.SendMailCommand).toBe("function");
        expect(typeof Eas.SmartForwardCommand).toBe("function");
        expect(typeof Eas.SmartReplyCommand).toBe("function");
        expect(typeof Eas.PingCommand).toBe("function");
        expect(typeof Eas.ItemOperationsCommand).toBe("function");
        expect(typeof Eas.SearchCommand).toBe("function");
        expect(typeof Eas.MeetingResponseCommand).toBe("function");
        expect(typeof Eas.SettingsCommand).toBe("function");
    });

    it("Re-exports every Sync collection adapter.", () => {
        // EmailSyncAdapter is abstract (it needs a backend-specific labelClass, supplied by
        // EmailSyncAdapterMongo/SQL - see src/mongo.js/src/sql.js) - a `typeof` check is all a
        // backend-agnostic instantiation can do; test/adapters/EmailSyncAdapter.test.ts exercises a real
        // instance via its own minimal concrete test subclass.
        expect(typeof Eas.EmailSyncAdapter).toBe("function");
        expect(typeof Eas.ContactsSyncAdapter).toBe("function");
        expect(typeof Eas.CalendarSyncAdapter).toBe("function");
        expect(typeof Eas.TasksSyncAdapter).toBe("function");
        expect(new Eas.ContactsSyncAdapter().collectionClass).toBe("Contacts");
    });
});
