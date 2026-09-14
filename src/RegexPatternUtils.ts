///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import { StringUtils } from "@rapidrest/core";

/**
 * Mirrors `@rapidrest/service-core`'s private `ModelUtils.MAX_PATTERN_LENGTH`: a `regex(...)` query operand
 * longer than this is rejected as a potential ReDoS pattern with `INVALID_REQUEST`. The check runs against the
 * operand AFTER escaping, so a raw client term well under the limit can still exceed it once each regex
 * metacharacter doubles in length.
 */
export const MAX_REGEX_PATTERN_LENGTH = 100;

/**
 * Escapes `value` for a literal-substring `regex(...)` match, truncating the raw term (never mid-escape or
 * mid-code-point) so the escaped result always fits `MAX_REGEX_PATTERN_LENGTH`. Matching on a prefix of an
 * over-long search term still yields a superset of the full term's matches, which is a far better outcome than
 * the whole command failing.
 */
export function boundedEscapedPattern(value: string, maxLength: number = MAX_REGEX_PATTERN_LENGTH): string {
    let pattern = "";
    for (const char of value) {
        const escaped = StringUtils.escapeRegExp(char);
        if (pattern.length + escaped.length > maxLength) {
            break;
        }
        pattern += escaped;
    }
    return pattern;
}
