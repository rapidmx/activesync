///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import { WbxmlCodePage } from "../codec/WbxmlCodePages.js";
import { element, textElement, type WbxmlElement } from "../codec/WbxmlElement.js";
import type { EasCollectionSyncAdapter } from "./EasCollectionSyncAdapter.js";
import { type Contact, type ContactPostalAddress, ContactAddressKind } from "@rapidmx/restapi";

/** MS-ASCMD only has three positional email slots (`Email1Address`/`Email2Address`/`Email3Address`) - unlike
 * `ContactEmail.type`, EAS doesn't distinguish a "kind" per address, only position. Extra addresses beyond the
 * third are dropped, matching this library's "pragmatic subset" precedent elsewhere. */
const EMAIL_TAGS = ["Email1Address", "Email2Address", "Email3Address"] as const;

/** MS-ASCONTACTS street/city/state/postalCode/country tag prefixes, keyed by `ContactAddressKind`. There is no
 * generic "OtherPhoneNumber"-equivalent tag family gap here (Home/Business/Other all exist for addresses,
 * unlike phone numbers below), so all three kinds round-trip. */
const ADDRESS_PREFIX: Record<ContactAddressKind, string> = {
    [ContactAddressKind.HOME]: "Home",
    [ContactAddressKind.WORK]: "Business",
    [ContactAddressKind.OTHER]: "Other",
};

/** MS-ASCONTACTS has no `OtherPhoneNumber`-equivalent tag - only Home/Business phone numbers exist as plain
 * single-value tags (plus several Home2/Business2/Car/Radio/Pager/Fax variants this pragmatic subset doesn't
 * use). A phone tagged `OTHER` in this library's model has nowhere to go and is dropped, documented here rather
 * than silently - matching `FolderSyncCommand`'s own precedent for this kind of unavoidable field-count gap. */
const PHONE_TAG: Partial<Record<ContactAddressKind, string>> = {
    [ContactAddressKind.HOME]: "HomePhoneNumber",
    [ContactAddressKind.WORK]: "BusinessPhoneNumber",
};

/**
 * Maps `Contact` to/from the EAS `Sync` `Contacts` collection class (MS-ASCONTACTS/MS-ASCNTC2). Contacts are
 * also this library's GAL source (see the architecture note on `Contact` itself), but that's `SearchCommand`'s
 * concern, not this adapter's.
 *
 * @author Jean-Philippe Steinmetz
 */
export class ContactsSyncAdapter implements EasCollectionSyncAdapter<Contact> {
    public readonly collectionClass = "Contacts";

    public toApplicationData(contact: Contact): WbxmlElement {
        const children: WbxmlElement[] = [
            textElement(WbxmlCodePage.Contacts, "FileAs", contact.displayName),
            ...(contact.givenName ? [textElement(WbxmlCodePage.Contacts, "FirstName", contact.givenName)] : []),
            ...(contact.surname ? [textElement(WbxmlCodePage.Contacts, "LastName", contact.surname)] : []),
            ...(contact.company ? [textElement(WbxmlCodePage.Contacts, "CompanyName", contact.company)] : []),
            ...(contact.jobTitle ? [textElement(WbxmlCodePage.Contacts, "JobTitle", contact.jobTitle)] : []),
        ];

        contact.emails.slice(0, EMAIL_TAGS.length).forEach((email, i) => {
            children.push(textElement(WbxmlCodePage.Contacts, EMAIL_TAGS[i], email.address));
        });

        for (const phone of contact.phones) {
            const tag = PHONE_TAG[phone.type];
            if (tag) {
                children.push(textElement(WbxmlCodePage.Contacts, tag, phone.phoneNumber));
            }
        }

        for (const address of contact.addresses) {
            children.push(...this.addressElements(address));
        }

        if (contact.notes) {
            children.push(
                element(WbxmlCodePage.AirSyncBase, "Body", [
                    textElement(WbxmlCodePage.AirSyncBase, "Type", "1"),
                    textElement(WbxmlCodePage.AirSyncBase, "EstimatedDataSize", String(Buffer.byteLength(contact.notes, "utf8"))),
                    textElement(WbxmlCodePage.AirSyncBase, "Data", contact.notes),
                ]),
            );
        }

        return element(WbxmlCodePage.AirSync, "ApplicationData", children);
    }

    private addressElements(address: ContactPostalAddress): WbxmlElement[] {
        const prefix = ADDRESS_PREFIX[address.type];
        const parts: [string, string | undefined][] = [
            [`${prefix}Street`, address.street],
            [`${prefix}City`, address.city],
            [`${prefix}State`, address.state],
            [`${prefix}PostalCode`, address.postalCode],
            [`${prefix}Country`, address.country],
        ];
        return parts
            .filter((part): part is [string, string] => part[1] !== undefined)
            .map(([tag, value]) => textElement(WbxmlCodePage.Contacts, tag, value));
    }
}
