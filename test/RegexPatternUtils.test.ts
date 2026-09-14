///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import { boundedEscapedPattern, MAX_REGEX_PATTERN_LENGTH } from "../src/RegexPatternUtils.js";

describe("RegexPatternUtils Tests", () => {
    it("Escapes a short term unchanged apart from regex metacharacters.", () => {
        expect(boundedEscapedPattern("a.b (c)")).toBe("a\\.b \\(c\\)");
    });

    it("Truncates the raw term so the escaped result fits, never splitting an escape sequence.", () => {
        expect(boundedEscapedPattern("a" + ".".repeat(200))).toBe("a" + "\\.".repeat(49));
        expect(boundedEscapedPattern("x".repeat(500)).length).toBe(MAX_REGEX_PATTERN_LENGTH);
        expect(boundedEscapedPattern("ab.", 3)).toBe("ab");
    });

    it("Never splits a surrogate pair.", () => {
        expect(boundedEscapedPattern("a😀", 2)).toBe("a");
    });
});
