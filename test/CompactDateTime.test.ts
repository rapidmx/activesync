///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
// CompactDateTime is pure binary-format-adjacent logic with no DI/DB dependency, tested directly here rather
// than only indirectly through a real-server HTTP round trip - the same precedent this project's own codec
// files (e.g. WbxmlCodec.test.ts) already set.
import { fromCompactDateTime, toCompactDateTime } from "../src/CompactDateTime.js";

describe("CompactDateTime Tests", () => {
    describe("toCompactDateTime", () => {
        it("Formats a Date as YYYYMMDDTHHMMSSZ in UTC.", () => {
            expect(toCompactDateTime(new Date("2026-01-02T03:04:05.000Z"))).toBe("20260102T030405Z");
        });

        it("Zero-pads single-digit month/day/hour/minute/second.", () => {
            expect(toCompactDateTime(new Date("2026-01-01T01:02:03.000Z"))).toBe("20260101T010203Z");
        });

        it("Accepts a string and normalizes it via new Date(...).", () => {
            expect(toCompactDateTime("2026-06-15T12:00:00.000Z")).toBe("20260615T120000Z");
        });
    });

    describe("fromCompactDateTime", () => {
        it("Parses a well-formed value back into the equivalent UTC Date.", () => {
            const date = fromCompactDateTime("20260102T030405Z");
            expect(date.toISOString()).toBe("2026-01-02T03:04:05.000Z");
        });

        it("Round-trips through toCompactDateTime.", () => {
            const original = new Date("2026-12-31T23:59:59.000Z");
            expect(fromCompactDateTime(toCompactDateTime(original)).toISOString()).toBe(original.toISOString());
        });

        it("Throws for a value with the wrong shape.", () => {
            expect(() => fromCompactDateTime("2026-01-02T03:04:05.000Z")).toThrow(/not a valid compact datetime/i);
        });

        it("Throws for a completely unrelated string.", () => {
            expect(() => fromCompactDateTime("garbage")).toThrow(/not a valid compact datetime/i);
        });
    });
});
