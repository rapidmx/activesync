///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
// ContactsSyncAdapter is pure mapping logic with no DI/DB dependency - toApplicationData is already exercised
// end-to-end via test/routes/{mongo,sql}/EasRoute.test.ts's real Sync command tests; this file is reserved for
// fromApplicationData's own ghosting/error-path edge cases, which are far more precise to verify directly than
// by threading malformed WBXML through a full HTTP+DB round trip.
import { WbxmlCodePage } from "../../src/codec/WbxmlCodePages.js";
import { element, textElement, type WbxmlElement } from "../../src/codec/WbxmlElement.js";
import { ContactsSyncAdapter } from "../../src/adapters/ContactsSyncAdapter.js";
import { ContactAddressKind } from "@rapidmx/restapi";

const adapter = new ContactsSyncAdapter();

function appData(children: WbxmlElement[]): WbxmlElement {
    return element(WbxmlCodePage.AirSync, "ApplicationData", children);
}

describe("ContactsSyncAdapter Tests", () => {
    it("Reports the Contacts collection class.", () => {
        expect(adapter.collectionClass).toBe("Contacts");
    });

    describe("fromApplicationData", () => {
        it("Parses every scalar field when present.", () => {
            const el = appData([
                textElement(WbxmlCodePage.Contacts, "FileAs", "Doe, Jane"),
                textElement(WbxmlCodePage.Contacts, "FirstName", "Jane"),
                textElement(WbxmlCodePage.Contacts, "LastName", "Doe"),
                textElement(WbxmlCodePage.Contacts, "CompanyName", "Acme"),
                textElement(WbxmlCodePage.Contacts, "JobTitle", "Engineer"),
            ]);
            expect(adapter.fromApplicationData(el)).toEqual({
                displayName: "Doe, Jane",
                givenName: "Jane",
                surname: "Doe",
                company: "Acme",
                jobTitle: "Engineer",
            });
        });

        it("Omits a scalar field from the partial when its tag is absent (ghosted).", () => {
            const el = appData([textElement(WbxmlCodePage.Contacts, "FileAs", "Doe, Jane")]);
            const partial = adapter.fromApplicationData(el);
            expect(partial).toEqual({ displayName: "Doe, Jane" });
            expect("givenName" in partial).toBe(false);
        });

        it("Leaves emails untouched when no Email*Address tag is present.", () => {
            const el = appData([textElement(WbxmlCodePage.Contacts, "FileAs", "X")]);
            expect(adapter.fromApplicationData(el).emails).toBeUndefined();
        });

        it("Rebuilds emails from whichever Email*Address tags are present, always as OTHER kind.", () => {
            const el = appData([
                textElement(WbxmlCodePage.Contacts, "Email1Address", "a@example.com"),
                textElement(WbxmlCodePage.Contacts, "Email3Address", "c@example.com"),
            ]);
            expect(adapter.fromApplicationData(el).emails).toEqual([
                { address: "a@example.com", type: ContactAddressKind.OTHER },
                { address: "c@example.com", type: ContactAddressKind.OTHER },
            ]);
        });

        it("Leaves phones untouched when neither Home nor Business phone tag is present.", () => {
            const el = appData([textElement(WbxmlCodePage.Contacts, "FileAs", "X")]);
            expect(adapter.fromApplicationData(el).phones).toBeUndefined();
        });

        it("Rebuilds phones from whichever Home/Business tags are present.", () => {
            const el = appData([
                textElement(WbxmlCodePage.Contacts, "HomePhoneNumber", "555-1111"),
                textElement(WbxmlCodePage.Contacts, "BusinessPhoneNumber", "555-2222"),
            ]);
            expect(adapter.fromApplicationData(el).phones).toEqual([
                { type: ContactAddressKind.HOME, phoneNumber: "555-1111" },
                { type: ContactAddressKind.WORK, phoneNumber: "555-2222" },
            ]);
        });

        it("Rebuilds only the phone slot(s) actually present, dropping the untouched one.", () => {
            const el = appData([textElement(WbxmlCodePage.Contacts, "HomePhoneNumber", "555-1111")]);
            expect(adapter.fromApplicationData(el).phones).toEqual([
                { type: ContactAddressKind.HOME, phoneNumber: "555-1111" },
            ]);
        });

        it("Leaves addresses untouched when no address tag of any kind is present.", () => {
            const el = appData([textElement(WbxmlCodePage.Contacts, "FileAs", "X")]);
            expect(adapter.fromApplicationData(el).addresses).toBeUndefined();
        });

        it("Rebuilds only the address kind(s) actually touched.", () => {
            const el = appData([
                textElement(WbxmlCodePage.Contacts, "HomeStreet", "1 Home St"),
                textElement(WbxmlCodePage.Contacts, "HomeCity", "Springfield"),
            ]);
            expect(adapter.fromApplicationData(el).addresses).toEqual([
                { type: ContactAddressKind.HOME, street: "1 Home St", city: "Springfield" },
            ]);
        });

        it("Parses multiple address kinds when both are touched.", () => {
            const el = appData([
                textElement(WbxmlCodePage.Contacts, "HomeCity", "Springfield"),
                textElement(WbxmlCodePage.Contacts, "BusinessCity", "Shelbyville"),
            ]);
            const addresses = adapter.fromApplicationData(el).addresses;
            expect(addresses).toHaveLength(2);
            expect(addresses).toEqual(
                expect.arrayContaining([
                    { type: ContactAddressKind.HOME, city: "Springfield" },
                    { type: ContactAddressKind.WORK, city: "Shelbyville" },
                ]),
            );
        });

        it("Parses notes from the AirSyncBase Body element.", () => {
            const el = appData([
                element(WbxmlCodePage.AirSyncBase, "Body", [
                    textElement(WbxmlCodePage.AirSyncBase, "Type", "1"),
                    textElement(WbxmlCodePage.AirSyncBase, "Data", "Some notes"),
                ]),
            ]);
            expect(adapter.fromApplicationData(el).notes).toBe("Some notes");
        });

        it("Leaves notes untouched when no Body element is present.", () => {
            const el = appData([textElement(WbxmlCodePage.Contacts, "FileAs", "X")]);
            expect(adapter.fromApplicationData(el).notes).toBeUndefined();
        });

        it("Parses categories from the Categories/Category elements.", () => {
            const el = appData([
                element(WbxmlCodePage.Contacts, "Categories", [
                    textElement(WbxmlCodePage.Contacts, "Category", "VIP"),
                    textElement(WbxmlCodePage.Contacts, "Category", "Historical"),
                ]),
            ]);
            expect(adapter.fromApplicationData(el).categories).toEqual(["VIP", "Historical"]);
        });

        it("Clears categories to an empty array when Categories is present but empty.", () => {
            const el = appData([element(WbxmlCodePage.Contacts, "Categories", [])]);
            expect(adapter.fromApplicationData(el).categories).toEqual([]);
        });

        it("Leaves categories untouched when no Categories element is present.", () => {
            const el = appData([textElement(WbxmlCodePage.Contacts, "FileAs", "X")]);
            expect(adapter.fromApplicationData(el).categories).toBeUndefined();
        });

        it("Returns an empty partial for an ApplicationData element with no recognized children.", () => {
            expect(adapter.fromApplicationData(appData([]))).toEqual({});
        });
    });
});
