///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
// The WBXML codec is pure binary-format logic with no DI/DB dependency, so it's tested directly here rather
// than only indirectly through a real-server HTTP round trip (which BaseEasRoute's own tests will still do,
// once that lands, using this exact codec to build/parse the request/response bytes).
import { WbxmlDecoder } from "../../src/codec/WbxmlDecoder.js";
import { WbxmlEncoder } from "../../src/codec/WbxmlEncoder.js";
import { codeForTagName, tagNameForCode, WbxmlCodePage } from "../../src/codec/WbxmlCodePages.js";
import {
    element,
    opaqueElement,
    textElement,
    findChild,
    findChildren,
    childText,
    type WbxmlElement,
} from "../../src/codec/WbxmlElement.js";

describe("WBXML codec Tests", () => {
    describe("Real captured ActiveSync traffic (Microsoft's own published worked example)", () => {
        // From "How to manually decode an ActiveSync WBXML stream" (Microsoft, archived MSDN blog) - a real
        // Sync request captured from an ActiveSync client, published byte-for-byte alongside its decoded XML.
        // Verifying against this exact, independently-authored stream (not just our own encode/decode
        // round-tripping) is the strongest available confirmation that this codec's binary framing (header,
        // tag content/attribute flag bits, SWITCH_PAGE, STR_I, END) matches the real wire protocol, not just
        // itself.
        const capturedRequestHex =
            "03 01 6A 00 45 5C 4F 4B 03 30 00 01 52 03 32 00 01 57 00 11 45 46 03 31 00 01 47 03 33 32 37 36 38 00 01 01 01 01 01 01";
        const capturedRequestBytes: Buffer = Buffer.from(capturedRequestHex.replace(/ /g, ""), "hex");

        // <Sync xmlns="AirSync">
        //   <Collections>
        //     <Collection>
        //       <SyncKey>0</SyncKey>
        //       <CollectionId>2</CollectionId>
        //       <Options>
        //         <airsyncbase:BodyPreference xmlns:airsyncbase="AirSyncBase">
        //           <airsyncbase:Type>1</airsyncbase:Type>
        //           <airsyncbase:TruncationSize>32768</airsyncbase:TruncationSize>
        //         </airsyncbase:BodyPreference>
        //       </Options>
        //     </Collection>
        //   </Collections>
        // </Sync>
        const capturedRequestTree: WbxmlElement = element(WbxmlCodePage.AirSync, "Sync", [
            element(WbxmlCodePage.AirSync, "Collections", [
                element(WbxmlCodePage.AirSync, "Collection", [
                    textElement(WbxmlCodePage.AirSync, "SyncKey", "0"),
                    textElement(WbxmlCodePage.AirSync, "CollectionId", "2"),
                    element(WbxmlCodePage.AirSync, "Options", [
                        element(WbxmlCodePage.AirSyncBase, "BodyPreference", [
                            textElement(WbxmlCodePage.AirSyncBase, "Type", "1"),
                            textElement(WbxmlCodePage.AirSyncBase, "TruncationSize", "32768"),
                        ]),
                    ]),
                ]),
            ]),
        ]);

        it("Encodes the tree to the exact real captured byte stream.", () => {
            const encoded: Buffer = new WbxmlEncoder().encode(capturedRequestTree);
            expect(encoded.equals(capturedRequestBytes)).toBe(true);
        });

        it("Decodes the real captured byte stream into the equivalent tree.", () => {
            const decoded: WbxmlElement = new WbxmlDecoder().decode(capturedRequestBytes);
            expect(decoded).toEqual(capturedRequestTree);
        });

        it("Round-trips the real captured byte stream (decode then re-encode) byte-for-byte.", () => {
            const decoded: WbxmlElement = new WbxmlDecoder().decode(capturedRequestBytes);
            const reEncoded: Buffer = new WbxmlEncoder().encode(decoded);
            expect(reEncoded.equals(capturedRequestBytes)).toBe(true);
        });
    });

    describe("Encode -> decode round-trips (synthetic cases)", () => {
        it("Round-trips a single leaf element with no content (self-closing, no children/text/opaque).", () => {
            const tree: WbxmlElement = element(WbxmlCodePage.AirSync, "GetChanges");
            const encoded: Buffer = new WbxmlEncoder().encode(tree);
            const decoded: WbxmlElement = new WbxmlDecoder().decode(encoded);
            expect(decoded).toEqual(tree);
        });

        it("Round-trips a leaf element carrying inline text.", () => {
            const tree: WbxmlElement = textElement(WbxmlCodePage.AirSync, "SyncKey", "42");
            const decoded: WbxmlElement = new WbxmlDecoder().decode(new WbxmlEncoder().encode(tree));
            expect(decoded).toEqual(tree);
        });

        it("Round-trips a leaf element carrying opaque binary content.", () => {
            const payload: Buffer = Buffer.from([0x00, 0x01, 0xff, 0x7f, 0x80, 0xaa, 0x00]);
            const tree: WbxmlElement = opaqueElement(WbxmlCodePage.ItemOperations, "Data", payload);
            const decoded: WbxmlElement = new WbxmlDecoder().decode(new WbxmlEncoder().encode(tree));
            expect(decoded).toEqual(tree);
            expect(decoded.opaque?.equals(payload)).toBe(true);
        });

        it("Round-trips opaque content large enough to require a multi-byte mb_u_int32 length (>127 bytes).", () => {
            const payload: Buffer = Buffer.alloc(500, 0x5a);
            const tree: WbxmlElement = opaqueElement(WbxmlCodePage.ItemOperations, "Data", payload);
            const decoded: WbxmlElement = new WbxmlDecoder().decode(new WbxmlEncoder().encode(tree));
            expect(decoded.opaque?.length).toBe(500);
            expect(decoded.opaque?.equals(payload)).toBe(true);
        });

        it("Round-trips text containing multi-byte UTF-8 characters.", () => {
            const tree: WbxmlElement = textElement(WbxmlCodePage.Contacts, "FirstName", "José 日本語 😀");
            const decoded: WbxmlElement = new WbxmlDecoder().decode(new WbxmlEncoder().encode(tree));
            expect(decoded.text).toBe("José 日本語 😀");
        });

        it("Round-trips a tree switching between more than two code pages across sibling elements.", () => {
            const tree: WbxmlElement = element(WbxmlCodePage.AirSync, "Sync", [
                textElement(WbxmlCodePage.AirSync, "SyncKey", "1"),
                element(WbxmlCodePage.Provision, "Policies", [
                    textElement(WbxmlCodePage.Provision, "PolicyKey", "123456789"),
                ]),
                textElement(WbxmlCodePage.AirSync, "GetChanges", "1"),
                element(WbxmlCodePage.Settings, "DeviceInformation", [
                    textElement(WbxmlCodePage.Settings, "Model", "TestPhone"),
                ]),
            ]);
            const decoded: WbxmlElement = new WbxmlDecoder().decode(new WbxmlEncoder().encode(tree));
            expect(decoded).toEqual(tree);
        });

        it("Does not emit a redundant SWITCH_PAGE when consecutive elements stay on the same code page.", () => {
            const tree: WbxmlElement = element(WbxmlCodePage.AirSyncBase, "BodyPreference", [
                textElement(WbxmlCodePage.AirSyncBase, "Type", "2"),
                textElement(WbxmlCodePage.AirSyncBase, "TruncationSize", "0"),
            ]);
            const encoded: Buffer = new WbxmlEncoder().encode(tree);
            // header(4) + SWITCH_PAGE(2, root itself isn't page 0) + BodyPreference tag(1) + Type(1+1+1+1+1)
            // + TruncationSize(1+1+1+1+1) + BodyPreference END(1) - exactly one SWITCH_PAGE (2 bytes) total.
            const switchPageOccurrences = [...encoded].filter((b, i) => b === 0x00 && encoded[i + 1] === WbxmlCodePage.AirSyncBase).length;
            expect(switchPageOccurrences).toBe(1);
        });

        it("Round-trips every tag on the Move (MoveItems) code page.", () => {
            const tree: WbxmlElement = element(WbxmlCodePage.Move, "MoveItems", [
                element(WbxmlCodePage.Move, "Move", [
                    textElement(WbxmlCodePage.Move, "SrcMsgId", "msg-1"),
                    textElement(WbxmlCodePage.Move, "SrcFldId", "folder-1"),
                    textElement(WbxmlCodePage.Move, "DstFldId", "folder-2"),
                ]),
                element(WbxmlCodePage.Move, "Response", [
                    textElement(WbxmlCodePage.Move, "Status", "3"),
                    textElement(WbxmlCodePage.Move, "DstMsgId", "msg-1"),
                ]),
            ]);
            const decoded: WbxmlElement = new WbxmlDecoder().decode(new WbxmlEncoder().encode(tree));
            expect(decoded).toEqual(tree);
        });

        it("Round-trips every tag on the ItemEstimate (GetItemEstimate) code page.", () => {
            const tree: WbxmlElement = element(WbxmlCodePage.ItemEstimate, "GetItemEstimate", [
                element(WbxmlCodePage.AirSync, "Collections", [
                    element(WbxmlCodePage.AirSync, "Collection", [
                        textElement(WbxmlCodePage.AirSync, "Class", "Email"),
                        textElement(WbxmlCodePage.AirSync, "CollectionId", "folder-1"),
                        element(WbxmlCodePage.ItemEstimate, "Response", [
                            textElement(WbxmlCodePage.ItemEstimate, "Status", "1"),
                            textElement(WbxmlCodePage.ItemEstimate, "Estimate", "12"),
                        ]),
                    ]),
                ]),
            ]);
            const decoded: WbxmlElement = new WbxmlDecoder().decode(new WbxmlEncoder().encode(tree));
            expect(decoded).toEqual(tree);
        });

        it("Round-trips every tag on the ResolveRecipients code page.", () => {
            const tree: WbxmlElement = element(WbxmlCodePage.ResolveRecipients, "ResolveRecipients", [
                textElement(WbxmlCodePage.ResolveRecipients, "To", "jane@example.com"),
                element(WbxmlCodePage.ResolveRecipients, "Response", [
                    textElement(WbxmlCodePage.ResolveRecipients, "Status", "1"),
                    element(WbxmlCodePage.ResolveRecipients, "Recipient", [
                        textElement(WbxmlCodePage.ResolveRecipients, "Type", "1"),
                        textElement(WbxmlCodePage.ResolveRecipients, "DisplayName", "Jane Doe"),
                        textElement(WbxmlCodePage.ResolveRecipients, "EmailAddress", "jane@example.com"),
                    ]),
                ]),
            ]);
            const decoded: WbxmlElement = new WbxmlDecoder().decode(new WbxmlEncoder().encode(tree));
            expect(decoded).toEqual(tree);
        });

        it("Round-trips deeply nested structural elements (Sync/Collections/Collection/Commands/Add/ApplicationData).", () => {
            const tree: WbxmlElement = element(WbxmlCodePage.AirSync, "Sync", [
                element(WbxmlCodePage.AirSync, "Collections", [
                    element(WbxmlCodePage.AirSync, "Collection", [
                        textElement(WbxmlCodePage.AirSync, "SyncKey", "5"),
                        element(WbxmlCodePage.AirSync, "Commands", [
                            element(WbxmlCodePage.AirSync, "Add", [
                                textElement(WbxmlCodePage.AirSync, "ServerId", "5:1"),
                                element(WbxmlCodePage.AirSync, "ApplicationData", [
                                    element(WbxmlCodePage.Email, "Attachments", []),
                                ]),
                            ]),
                        ]),
                    ]),
                ]),
            ]);
            const decoded: WbxmlElement = new WbxmlDecoder().decode(new WbxmlEncoder().encode(tree));
            expect(decoded).toEqual(tree);
        });
    });

    describe("Error handling", () => {
        it("Throws when encoding a tag name with no registered token on the given code page.", () => {
            const encoder = new WbxmlEncoder();
            expect(() => encoder.encode(textElement(WbxmlCodePage.AirSync, "NotARealTag", "x"))).toThrow(
                /no token registered/,
            );
        });

        it("Decodes an unrecognized tag code into a synthetic placeholder name rather than throwing.", () => {
            // Code 0x3f is unassigned on the Ping page - see WbxmlCodePages.ts's own table.
            const tag = tagNameForCode(WbxmlCodePage.Ping, 0x3f);
            expect(tag).toBe("Unknown0x3f");
        });

        it("Throws when decoding a tag byte with the (unsupported) attribute flag set.", () => {
            // header + a Sync tag byte (0x05) with both content(0x40) and attribute(0x80) flags set.
            const bytes = Buffer.from([0x03, 0x01, 0x6a, 0x00, 0x05 | 0x40 | 0x80]);
            expect(() => new WbxmlDecoder().decode(bytes)).toThrow(/attributes are not supported/);
        });

        it("Throws when the buffer ends mid-header (before the version byte's follow-on fields).", () => {
            // Only the version byte is present - reading `publicid` immediately runs off the end of the
            // buffer inside `readMbUint()`'s own `readByte()` call, distinct from the content-parsing loop's
            // own explicit end-of-buffer check exercised by the test below.
            expect(() => new WbxmlDecoder().decode(Buffer.from([0x03]))).toThrow(/unexpected end of buffer/);
        });

        it("Throws when the buffer ends before a tag's content is terminated.", () => {
            // header + Sync tag (with content flag) but no following END token.
            const bytes = Buffer.from([0x03, 0x01, 0x6a, 0x00, 0x05 | 0x40]);
            expect(() => new WbxmlDecoder().decode(bytes)).toThrow(/unexpected end of buffer/);
        });

        it("Throws when an inline string (STR_I) is never null-terminated.", () => {
            const bytes = Buffer.from([0x03, 0x01, 0x6a, 0x00, 0x05 | 0x40, 0x03, 0x41, 0x42]);
            expect(() => new WbxmlDecoder().decode(bytes)).toThrow(/unterminated inline string/);
        });

        it("codeForTagName() throws for an unregistered tag/page pair.", () => {
            expect(() => codeForTagName(WbxmlCodePage.AirSync, "DoesNotExist")).toThrow(/no token registered/);
        });

        it("Throws a bounded 'maximum nesting depth' error rather than a raw stack overflow for pathologically deep nesting.", () => {
            // header + 250 content-flagged Sync tag bytes (each ~2 bytes of wire format), then 250 matching
            // ENDs to close them all - a crafted request could reach this depth in well under a kilobyte,
            // exercising the exact DoS surface the depth cap exists to close off.
            const depth = 250;
            const header = Buffer.from([0x03, 0x01, 0x6a, 0x00]);
            const opens = Buffer.alloc(depth, 0x05 | 0x40);
            const closes = Buffer.alloc(depth, 0x01);
            const bytes = Buffer.concat([header, opens, closes]);

            expect(() => new WbxmlDecoder().decode(bytes)).toThrow(/exceeded maximum nesting depth/);
        });
    });

    describe("WbxmlElement helpers", () => {
        const parent: WbxmlElement = element(WbxmlCodePage.AirSync, "Collection", [
            textElement(WbxmlCodePage.AirSync, "SyncKey", "1"),
            textElement(WbxmlCodePage.AirSync, "CollectionId", "2"),
            textElement(WbxmlCodePage.AirSync, "CollectionId", "3"),
        ]);

        it("findChild() returns the first direct child with the given tag.", () => {
            expect(findChild(parent, "CollectionId")?.text).toBe("2");
        });

        it("findChild() returns undefined when no direct child matches.", () => {
            expect(findChild(parent, "Status")).toBeUndefined();
        });

        it("findChildren() returns every direct child with the given tag.", () => {
            expect(findChildren(parent, "CollectionId").map((c) => c.text)).toEqual(["2", "3"]);
        });

        it("childText() shorthand returns the first matching child's text value.", () => {
            expect(childText(parent, "SyncKey")).toBe("1");
        });

        it("childText() returns undefined when no direct child matches.", () => {
            expect(childText(parent, "Status")).toBeUndefined();
        });
    });
});
