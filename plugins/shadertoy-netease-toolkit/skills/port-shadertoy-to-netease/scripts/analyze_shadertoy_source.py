#!/usr/bin/env python3
"""Read-only heuristic analysis for Shadertoy and GLSL source files.

The script deliberately does not invoke a GLSL compiler, a Minecraft client,
MCDK, or any shader loader.  A successful scan only means that the source was
read and inspected by these conservative text-level checks.

Structured reports expose ``schema_version`` independently from the tool
implementation version so callers can validate their result contract.
"""

from __future__ import print_function

import argparse
import bisect
import json
from collections import Counter
from pathlib import Path
import re
import sys


TOOL_NAME = "analyze_shadertoy_source"
TOOL_VERSION = 2
SCHEMA_VERSION = 1
VALID_TARGETS = ("unknown", "gles100", "gles300")
MAX_FINDINGS_PER_RULE = 8
# Shadertoy source files are normally far smaller than this. The limit keeps a
# malformed or accidental binary input from turning a source-only check into a
# memory or worst-case parsing problem.
MAX_SOURCE_BYTES = 2 * 1024 * 1024
# Retained as a compatibility alias. The byte limit above is authoritative for
# both file and in-memory public entry points.
MAX_SOURCE_CHARACTERS = MAX_SOURCE_BYTES

SHADERTOY_SYMBOLS = (
    "iResolution",
    "iTime",
    "iTimeDelta",
    "iFrame",
    "iFrameRate",
    "iMouse",
    "iDate",
    "iSampleRate",
    "iChannelTime",
    "iChannelResolution",
    "iChannel0",
    "iChannel1",
    "iChannel2",
    "iChannel3",
)

NUMBER_LITERAL_RE = re.compile(
    r"^[+-]?(?:(?:\d+(?:\.\d*)?)|(?:\.\d+))(?:[eE][+-]?\d+)?[fF]?$"
)
NUMBER_PREFIX_RE = re.compile(
    r"[+-]?(?:(?:\d+(?:\.\d*)?)|(?:\.\d+))(?:[eE][+-]?\d+)?[fF]?"
)
PASS_TOKEN_RE = re.compile(
    r"\b(?P<pass>common|image|buffer\s*[a-d])\b", re.IGNORECASE
)


def _validate_target(target):
    """Return a supported compatibility baseline or raise a stable error."""

    if target not in VALID_TARGETS:
        raise ValueError(
            "target must be one of: {0}".format(", ".join(VALID_TARGETS))
        )
    return target


def _new_report(path, pass_name, status, target, source_characters=None):
    """Create the fixed report shape used for analyzed and unscanned input."""

    return {
        "schema_version": SCHEMA_VERSION,
        "path": str(path),
        "pass_name": pass_name,
        "status": status,
        "target_baseline": target,
        "source_characters": source_characters,
        "entrypoints": [],
        "shadertoy_references": {},
        "channels": [],
        "uniform_declarations": [],
        "compatibility_features": [],
        "findings": [],
        "disclaimer": "",
    }


def _unscanned_report(
    path,
    pass_name,
    status,
    target,
    code,
    message,
    source_characters=None,
):
    """Return a fixed-shape report for intentionally skipped or unreadable input."""

    report = _new_report(
        path, pass_name, status, target, source_characters
    )
    report["findings"].append(
        {
            "severity": "error",
            "category": "input",
            "code": code,
            "line": 1,
            "message": message,
        }
    )
    report["disclaimer"] = (
        "No source analysis was performed. This tool does not compile or run shaders."
    )
    return report


class LineIndex(object):
    """Translate character offsets into one-based line numbers."""

    def __init__(self, text):
        self._newlines = [match.start() for match in re.finditer(r"\n", text)]

    def line_at(self, offset):
        return bisect.bisect_right(self._newlines, offset) + 1


class Findings(object):
    """Collect deterministic, de-duplicated findings."""

    def __init__(self):
        self._items = []
        self._seen = set()

    def add(self, severity, category, code, line, message):
        key = (severity, category, code, line, message)
        if key in self._seen:
            return
        self._seen.add(key)
        self._items.append(
            {
                "severity": severity,
                "category": category,
                "code": code,
                "line": line,
                "message": message,
            }
        )

    def sorted_items(self):
        severity_order = {"error": 0, "warning": 1, "info": 2}
        return sorted(
            self._items,
            key=lambda item: (
                item["line"],
                severity_order.get(item["severity"], 9),
                item["category"],
                item["code"],
            ),
        )


def strip_comments(source):
    """Replace comments with spaces while preserving all source line numbers."""

    output = []
    index = 0
    state = "code"
    length = len(source)

    while index < length:
        character = source[index]
        next_character = source[index + 1] if index + 1 < length else ""

        if state == "code":
            if character == "/" and next_character == "/":
                output.extend((" ", " "))
                index += 2
                state = "line_comment"
                continue
            if character == "/" and next_character == "*":
                output.extend((" ", " "))
                index += 2
                state = "block_comment"
                continue
            output.append(character)
            index += 1
            continue

        if state == "line_comment":
            if character == "\n":
                output.append("\n")
                state = "code"
            else:
                output.append(" ")
            index += 1
            continue

        # block_comment
        if character == "*" and next_character == "/":
            output.extend((" ", " "))
            index += 2
            state = "code"
        elif character == "\n":
            output.append("\n")
            index += 1
        else:
            output.append(" ")
            index += 1

    return "".join(output)


def _normalise_pass_token(value):
    match = PASS_TOKEN_RE.fullmatch(value.strip())
    if not match:
        return None
    token = re.sub(r"\s+", "", match.group("pass").lower())
    if token == "common":
        return "Common"
    if token == "image":
        return "Image"
    if token.startswith("buffer"):
        return "Buffer " + token[-1].upper()
    return None


def infer_pass_name(path, source):
    """Infer a Shadertoy pass name from a source header or the file stem."""

    header = "\n".join(source.splitlines()[:48])
    explicit_header_patterns = (
        re.compile(
            r"^[ \t]*//[ \t]*(?:shadertoy[ \t]+pass|pass)(?:[ \t]*:)?"
            r"[ \t]*(?P<pass>common|image|buffer[ \t]*[a-d])[ \t]*$",
            re.IGNORECASE | re.MULTILINE,
        ),
        re.compile(
            r"^[ \t]*//[ \t]*(?P<pass>common|image|buffer[ \t]*[a-d])[ \t]*$",
            re.IGNORECASE | re.MULTILINE,
        ),
    )
    for pattern in explicit_header_patterns:
        header_match = pattern.search(header)
        if header_match:
            inferred = _normalise_pass_token(header_match.group("pass"))
            if inferred:
                return inferred

    stem = Path(path).stem
    compact_stem = re.sub(r"[^a-z0-9]+", "", stem.lower())
    direct_names = {
        "common": "Common",
        "image": "Image",
        "main": "Image",
        "mainimage": "Image",
        "buffera": "Buffer A",
        "bufferb": "Buffer B",
        "bufferc": "Buffer C",
        "bufferd": "Buffer D",
    }
    return direct_names.get(compact_stem, stem or "Unnamed pass")


def _matching_lines(pattern, source, line_index):
    return sorted(
        {
            line_index.line_at(match.start())
            for match in pattern.finditer(source)
        }
    )


def _number_literal(value):
    value = value.strip()
    if not NUMBER_LITERAL_RE.match(value):
        return None
    try:
        return float(value.rstrip("fF"))
    except ValueError:
        return None


def _parenthesis_pairs(source):
    """Return matching parentheses from one linear scan of sanitized source."""

    pairs = {}
    stack = []
    for offset, character in enumerate(source):
        if character == "(":
            stack.append(offset)
        elif character == ")" and stack:
            pairs[stack.pop()] = offset
    return pairs


def _split_top_level_arguments(arguments):
    result = []
    start = 0
    depth = 0
    for offset, character in enumerate(arguments):
        if character in "([{":
            depth += 1
        elif character in ")]}":
            depth = max(0, depth - 1)
        elif character == "," and depth == 0:
            result.append(arguments[start:offset].strip())
            start = offset + 1
    result.append(arguments[start:].strip())
    return result


def _iter_function_calls(
    source,
    function_names,
    parenthesis_pairs=None,
    max_calls=MAX_FINDINGS_PER_RULE + 1,
):
    """Yield (name, argument_text, call_offset) for complete function calls."""

    if not function_names:
        return
    if parenthesis_pairs is None:
        parenthesis_pairs = _parenthesis_pairs(source)
    name_pattern = "|".join(re.escape(name) for name in function_names)
    pattern = re.compile(r"\b(?P<name>" + name_pattern + r")\s*\(")

    yielded = 0
    for match in pattern.finditer(source):
        opening_offset = match.end() - 1
        closing_offset = parenthesis_pairs.get(opening_offset)
        if closing_offset is None:
            continue
        yield (
            match.group("name"),
            source[opening_offset + 1 : closing_offset],
            match.start(),
        )
        yielded += 1
        if max_calls is not None and yielded >= max_calls:
            break


def _function_definition_lines(
    source, line_index, function_name, parenthesis_pairs=None
):
    """Find void function definitions, excluding prototypes such as void main();"""

    if parenthesis_pairs is None:
        parenthesis_pairs = _parenthesis_pairs(source)
    pattern = re.compile(
        r"\bvoid[ \t\r\n]+" + re.escape(function_name) + r"[ \t\r\n]*\("
    )
    lines = []
    for match in pattern.finditer(source):
        opening_offset = match.end() - 1
        closing_offset = parenthesis_pairs.get(opening_offset)
        if closing_offset is None:
            continue
        cursor = closing_offset + 1
        while cursor < len(source) and source[cursor].isspace():
            cursor += 1
        if cursor < len(source) and source[cursor] == "{":
            lines.append(line_index.line_at(match.start()))
    return sorted(set(lines))


def _add_limited_line_findings(
    findings, lines, severity, category, code, message, extra_message=None
):
    for line in lines[:MAX_FINDINGS_PER_RULE]:
        findings.add(severity, category, code, line, message)
    if len(lines) > MAX_FINDINGS_PER_RULE and extra_message:
        findings.add(
            "info",
            "analysis",
            code + "_truncated",
            lines[MAX_FINDINGS_PER_RULE],
            extra_message,
        )


def _record_feature(features, name, lines):
    if lines:
        features.append({"name": name, "lines": lines})


def _uniform_declarations(source, line_index):
    declarations = []
    spans = []
    pattern = re.compile(
        r"\buniform\s+"
        r"(?:(?:lowp|mediump|highp)\s+)?"
        r"(?P<type>[A-Za-z_]\w*)\s+"
        r"(?P<names>[^;]+);",
        re.MULTILINE | re.DOTALL,
    )
    for match in pattern.finditer(source):
        spans.append((match.start(), match.end()))
        names = match.group("names")
        for name_match in re.finditer(
            r"(?:^|,)[ \t\r\n]*(?P<name>[A-Za-z_]\w*)", names
        ):
            declarations.append(
                {
                    "name": name_match.group("name"),
                    "type": match.group("type"),
                    "line": line_index.line_at(
                        match.start("names") + name_match.start("name")
                    ),
                }
            )
    return declarations, spans


def _shadertoy_references(source, line_index, declaration_spans=()):
    declaration_spans = tuple(sorted(declaration_spans))
    declaration_starts = tuple(start for start, _ in declaration_spans)

    def inside_declaration(offset):
        span_index = bisect.bisect_right(declaration_starts, offset) - 1
        return (
            span_index >= 0
            and offset < declaration_spans[span_index][1]
        )

    references = {}
    for symbol in SHADERTOY_SYMBOLS:
        lines = sorted(
            {
                line_index.line_at(match.start())
                for match in re.finditer(
                    r"\b" + re.escape(symbol) + r"\b", source
                )
                if not inside_declaration(match.start())
            }
        )
        if lines:
            references[symbol] = lines
    return references


def _looks_like_array_declaration(source, match):
    """Avoid treating a typed array declaration as a dynamic array access."""

    qualifiers = (
        r"(?:(?:const|uniform|in|out|lowp|mediump|highp|"
        r"flat|smooth|centroid)[ \t\r\n]+)*"
    )
    type_name = r"[A-Za-z_]\w*"
    declarator = r"[A-Za-z_]\w*(?:[ \t\r\n]*\[[^\]]*\])?"

    statement_start = max(
        source.rfind(";", 0, match.start()),
        source.rfind("{", 0, match.start()),
        source.rfind("}", 0, match.start()),
    ) + 1
    prefix = source[statement_start:match.start()]
    declaration_prefix = re.compile(
        r"^[ \t\r\n]*"
        + qualifiers
        + type_name
        + r"[ \t\r\n]+(?:"
        + declarator
        + r"[ \t\r\n]*,[ \t\r\n]*)*$"
    )
    if declaration_prefix.match(prefix):
        return True

    # Function parameters begin after the nearest opening parenthesis or comma.
    parameter_start = max(
        source.rfind("(", 0, match.start()),
        source.rfind(",", 0, match.start()),
    ) + 1
    parameter_prefix = source[parameter_start:match.start()]
    return bool(
        re.match(
            r"^[ \t\r\n]*"
            + qualifiers
            + type_name
            + r"[ \t\r\n]+$",
            parameter_prefix,
        )
    )


def _add_compatibility_findings(source, line_index, target, findings, features):
    version_pattern = re.compile(
        r"^[ \t]*#[ \t]*version[ \t]+(?P<number>\d+)"
        r"(?:[ \t]+(?P<profile>es|core|compatibility))?"
        r"(?:[ \t]+[^\r\n]*)?$",
        re.IGNORECASE | re.MULTILINE,
    )
    version_matches = list(version_pattern.finditer(source))
    version_lines = [line_index.line_at(match.start()) for match in version_matches]
    _record_feature(features, "explicit_version_directive", version_lines)
    for match in version_matches:
        version_number = int(match.group("number"))
        profile = (match.group("profile") or "").lower()
        line = line_index.line_at(match.start())
        directive = match.group(0).strip()
        is_es100 = version_number == 100 and not profile
        is_es_profile = profile == "es"
        is_desktop_or_unspecified = profile in ("core", "compatibility") or (
            not profile and not is_es100
        )

        if target == "unknown":
            findings.add(
                "info",
                "compatibility",
                "version_target_unknown",
                line,
                "{0} was found. The target profile needs verification; a desktop version directive must not be treated as an ES guarantee.".format(
                    directive
                ),
            )
        elif target == "gles100" and is_es100:
            findings.add(
                "info",
                "compatibility",
                "version_directive",
                line,
                "An explicit GLSL version directive is present; host-side injected headers may still change the effective dialect.",
            )
        elif target == "gles100" and is_es_profile:
            findings.add(
                "warning",
                "compatibility",
                "gles300_version",
                line,
                "{0} requests a newer GLSL ES profile than the GLSL ES 1.00 baseline; verify the actual NetEase target before translating it.".format(
                    directive
                ),
            )
        elif target == "gles100" and is_desktop_or_unspecified:
            findings.add(
                "warning",
                "compatibility",
                "desktop_or_unspecified_version",
                line,
                "{0} is desktop or profile-unspecified GLSL, not GLSL ES 1.00. Verify the actual NetEase target.".format(
                    directive
                ),
            )
        elif target == "gles300" and is_es_profile and version_number == 300:
            findings.add(
                "info",
                "compatibility",
                "version_directive",
                line,
                "An explicit GLSL ES 3.00 directive is present; host-side injected headers may still change the effective dialect.",
            )
        elif target == "gles300" and (
            is_es100 or (is_es_profile and version_number < 300)
        ):
            findings.add(
                "warning",
                "compatibility",
                "pre_gles300_version",
                line,
                "{0} is older than the GLSL ES 3.00 baseline; verify the required translation and host headers.".format(
                    directive
                ),
            )
        elif target == "gles300" and is_es_profile and version_number > 300:
            findings.add(
                "warning",
                "compatibility",
                "newer_gles_version",
                line,
                "{0} requires a newer GLSL ES profile than the requested 3.00 baseline.".format(
                    directive
                ),
            )
        elif target == "gles300" and is_desktop_or_unspecified:
            findings.add(
                "warning",
                "compatibility",
                "desktop_or_unspecified_version",
                line,
                "{0} is desktop or profile-unspecified GLSL, not proof of GLSL ES 3.00 compatibility.".format(
                    directive
                ),
            )

    precision_pattern = re.compile(
        r"^[ \t]*precision\s+(?:lowp|mediump|highp)\s+float\s*;",
        re.MULTILINE,
    )
    precision_lines = _matching_lines(precision_pattern, source, line_index)
    _record_feature(features, "default_float_precision", precision_lines)
    if target == "gles100" and not precision_lines:
        findings.add(
            "info",
            "compatibility",
            "precision_not_explicit",
            1,
            "No default float precision declaration was found. The NetEase shader host may inject one; verify the real entry file before adding it.",
        )
    elif target == "unknown" and not precision_lines:
        findings.add(
            "info",
            "compatibility",
            "precision_target_unknown",
            1,
            "No default float precision declaration was found. The target dialect is unknown, so the actual NetEase shader entry needs verification.",
        )

    checks = (
        (
            "layout_qualifier",
            re.compile(r"\blayout\s*\("),
            "warning",
            "layout_qualifier",
            "Layout qualifiers are not part of the GLSL ES 1.00 baseline; verify the target shader route before porting.",
        ),
        (
            "es3_sampling",
            re.compile(r"\b(?:texelFetch|textureLod|textureGrad|textureProj)\s*\("),
            "warning",
            "es3_sampling",
            "This texture operation needs target-dialect verification and is not a portable GLSL ES 1.00 baseline call.",
        ),
        (
            "unsigned_or_bitwise",
            re.compile(
                r"\b(?:uint|uvec[234])\b|<<|>>|(?<![&])&(?![&])|"
                r"(?<![|])\|(?![|])|(?<!\^)\^(?!\^)"
            ),
            "warning",
            "unsigned_or_bitwise",
            "Unsigned integer or bitwise syntax needs GLSL ES target verification before it is used in a NetEase shader.",
        ),
        (
            "advanced_sampler",
            re.compile(r"\b(?:sampler3D|sampler2DArray|samplerCubeArray)\b"),
            "warning",
            "advanced_sampler",
            "This sampler type requires verification against the actual NetEase material and shader target.",
        ),
        (
            "array_constructor",
            re.compile(r"\b(?:float|int|bool|vec[234]|ivec[234]|mat[234])\s*\[\s*\d+\s*\]\s*\("),
            "warning",
            "array_constructor",
            "GLSL array-constructor syntax is not portable to the GLSL ES 1.00 baseline; rewrite only after checking the target route.",
        ),
        (
            "array_length",
            re.compile(r"\.\s*length\s*\(\s*\)"),
            "warning",
            "array_length",
            "Array length queries need target-dialect verification; use an explicit constant only when that preserves the source behavior.",
        ),
        (
            "depth_write",
            re.compile(r"\bgl_FragDepth\b"),
            "warning",
            "depth_write",
            "Fragment depth writes can change render ordering and require route-specific support verification.",
        ),
        (
            "discard",
            re.compile(r"\bdiscard\s*;"),
            "info",
            "discard",
            "Discard changes alpha/depth behavior; retain an appropriate material and fallback path when integrating it.",
        ),
    )

    gles100_only_features = {
        "layout_qualifier",
        "es3_sampling",
        "unsigned_or_bitwise",
        "advanced_sampler",
        "array_constructor",
        "array_length",
    }
    for feature_name, pattern, severity, code, message in checks:
        lines = _matching_lines(pattern, source, line_index)
        _record_feature(features, feature_name, lines)
        if feature_name in gles100_only_features:
            if target == "gles100":
                _add_limited_line_findings(
                    findings,
                    lines,
                    severity,
                    "compatibility",
                    code,
                    message,
                    "Additional occurrences of this compatibility feature were omitted from the human-oriented finding list.",
                )
            elif target == "unknown":
                _add_limited_line_findings(
                    findings,
                    lines,
                    "info",
                    "compatibility",
                    "target_unknown_" + feature_name,
                    "The target shader dialect is unknown. This feature was found and needs verification against the actual NetEase shader entry.",
                    "Additional occurrences of this target-sensitive feature were omitted from the human-oriented finding list.",
                )
            continue
        _add_limited_line_findings(
            findings,
            lines,
            severity,
            "compatibility",
            code,
            message,
            "Additional occurrences of this compatibility feature were omitted from the human-oriented finding list.",
        )

    generic_texture_lines = _matching_lines(
        re.compile(r"\btexture\s*\("), source, line_index
    )
    _record_feature(features, "generic_texture_function", generic_texture_lines)
    if target == "gles100":
        _add_limited_line_findings(
            findings,
            generic_texture_lines,
            "warning",
            "compatibility",
            "generic_texture_function",
            "The generic texture() function needs adaptation or target verification for a GLSL ES 1.00-style shader entry.",
            "Additional texture() calls were omitted from the human-oriented finding list.",
        )
    elif target == "unknown":
        _add_limited_line_findings(
            findings,
            generic_texture_lines,
            "info",
            "compatibility",
            "target_unknown_generic_texture_function",
            "The target shader dialect is unknown. The generic texture() function was found and needs verification against the actual NetEase shader entry.",
            "Additional texture() calls were omitted from the human-oriented finding list.",
        )

    global_io_pattern = re.compile(
        r"^[ \t]*(?:flat\s+)?(?:in|out)\s+"
        r"(?:(?:lowp|mediump|highp)\s+)?"
        r"[A-Za-z_]\w*\s+[A-Za-z_]\w*(?:\s*\[[^\]]+\])?\s*;",
        re.MULTILINE,
    )
    global_io_lines = _matching_lines(global_io_pattern, source, line_index)
    _record_feature(features, "global_in_out_qualifiers", global_io_lines)
    if target == "gles100":
        _add_limited_line_findings(
            findings,
            global_io_lines,
            "warning",
            "compatibility",
            "global_in_out_qualifiers",
            "Global in/out shader-interface qualifiers need GLSL ES 1.00 adaptation or a confirmed newer target entry.",
            "Additional global in/out declarations were omitted from the human-oriented finding list.",
        )
    elif target == "unknown":
        _add_limited_line_findings(
            findings,
            global_io_lines,
            "info",
            "compatibility",
            "target_unknown_global_in_out_qualifiers",
            "The target shader dialect is unknown. Global in/out qualifiers were found and need verification against the actual NetEase shader entry.",
            "Additional global in/out declarations were omitted from the human-oriented finding list.",
        )

    derivative_pattern = re.compile(r"\b(?:dFdx|dFdy|fwidth)\s*\(")
    derivative_lines = _matching_lines(derivative_pattern, source, line_index)
    _record_feature(features, "derivatives", derivative_lines)
    derivative_extension_lines = _matching_lines(
        re.compile(
            r"^[ \t]*#[ \t]*extension[ \t]+GL_OES_standard_derivatives\b",
            re.MULTILINE,
        ),
        source,
        line_index,
    )
    _record_feature(
        features, "oes_standard_derivatives_extension", derivative_extension_lines
    )
    if derivative_lines and target == "gles100":
        detail = (
            "Derivative functions require a supported derivative extension or a newer GLSL ES target; source-only analysis cannot confirm host support."
        )
        if derivative_extension_lines:
            detail = (
                "Derivative functions and a derivative extension declaration were found; verify that the actual NetEase shader entry enables and supports it."
            )
        _add_limited_line_findings(
            findings,
            derivative_lines,
            "warning",
            "compatibility",
            "derivatives",
            detail,
            "Additional derivative calls were omitted from the human-oriented finding list.",
        )
    elif derivative_lines and target == "unknown":
        _add_limited_line_findings(
            findings,
            derivative_lines,
            "info",
            "compatibility",
            "target_unknown_derivatives",
            "The target shader dialect is unknown. Derivative functions were found and need verification against the actual NetEase shader entry.",
            "Additional derivative calls were omitted from the human-oriented finding list.",
        )

    dynamic_index_pattern = re.compile(
        r"\b(?P<name>[A-Za-z_]\w*)\s*\[\s*(?P<index>[^\]\r\n]+?)\s*\]"
    )
    dynamic_index_lines = []
    for match in dynamic_index_pattern.finditer(source):
        index_text = match.group("index").strip()
        if (
            _number_literal(index_text) is None
            and not _looks_like_array_declaration(source, match)
        ):
            dynamic_index_lines.append(line_index.line_at(match.start()))
    dynamic_index_lines = sorted(set(dynamic_index_lines))
    _record_feature(features, "dynamic_array_indexing", dynamic_index_lines)
    if target == "gles100":
        _add_limited_line_findings(
            findings,
            dynamic_index_lines,
            "warning",
            "compatibility",
            "dynamic_array_indexing",
            "Non-literal array indexing needs verification against the target GLSL ES compiler and should not be rewritten blindly.",
            "Additional dynamic array indexes were omitted from the human-oriented finding list.",
        )
    elif target == "unknown":
        _add_limited_line_findings(
            findings,
            dynamic_index_lines,
            "info",
            "compatibility",
            "target_unknown_dynamic_array_indexing",
            "The target shader dialect is unknown. Non-literal array indexing was found and needs verification before choosing a porting path.",
            "Additional dynamic array indexes were omitted from the human-oriented finding list.",
        )

    gles300_legacy_checks = (
        (
            "legacy_varying_attribute",
            re.compile(r"^[ \t]*(?:varying|attribute)\b", re.MULTILINE),
            "legacy_varying_attribute",
            "varying/attribute declarations are legacy GLSL ES 1.00 interface syntax; use the target's confirmed GLSL ES 3.00 interface convention.",
        ),
        (
            "legacy_fragment_output",
            re.compile(r"\bgl_Frag(?:Color|Data)\b"),
            "legacy_fragment_output",
            "gl_FragColor/gl_FragData are legacy fragment outputs for a GLSL ES 3.00 target; verify the actual output declaration convention.",
        ),
        (
            "legacy_texture_function",
            re.compile(
                r"\b(?:texture2D|textureCube|texture2DProj|textureCubeLod)\s*\("
            ),
            "legacy_texture_function",
            "texture2D/textureCube-style calls are legacy for a GLSL ES 3.00 target; verify whether the actual NetEase route expects texture().",
        ),
    )
    for feature_name, pattern, code, message in gles300_legacy_checks:
        lines = _matching_lines(pattern, source, line_index)
        _record_feature(features, feature_name, lines)
        if target == "gles300":
            _add_limited_line_findings(
                findings,
                lines,
                "warning",
                "compatibility",
                code,
                message,
                "Additional legacy GLSL ES 1.00 occurrences were omitted from the human-oriented finding list.",
            )
        elif target == "unknown":
            _add_limited_line_findings(
                findings,
                lines,
                "info",
                "compatibility",
                "target_unknown_" + feature_name,
                "The target shader dialect is unknown. Legacy-looking syntax was found and needs verification before choosing a porting path.",
                "Additional legacy-looking occurrences were omitted from the human-oriented finding list.",
            )

    loop_pattern = re.compile(
        r"\bfor\s*\(\s*(?P<initialiser>[^;]*);\s*(?P<condition>[^;]*);",
        re.MULTILINE | re.DOTALL,
    )
    float_loop_lines = []
    dynamic_loop_lines = []
    for match in loop_pattern.finditer(source):
        line = line_index.line_at(match.start())
        initialiser = match.group("initialiser")
        condition = match.group("condition").strip()
        if re.search(r"\bfloat\b", initialiser):
            float_loop_lines.append(line)
        comparison = re.search(r"(?:<=|>=|<|>)\s*(?P<bound>.+)$", condition)
        if comparison and _number_literal(comparison.group("bound").strip()) is None:
            dynamic_loop_lines.append(line)
    float_loop_lines = sorted(set(float_loop_lines))
    dynamic_loop_lines = sorted(set(dynamic_loop_lines))
    _record_feature(features, "float_loop_counter", float_loop_lines)
    _record_feature(features, "non_literal_loop_bound", dynamic_loop_lines)
    if target == "unknown":
        loop_severity = "info"
        float_loop_message = (
            "The target shader dialect is unknown. A floating-point loop counter was found and needs compiler and frame-budget verification."
        )
        dynamic_loop_message = (
            "The target shader dialect is unknown. This non-literal loop bound needs compiler and frame-budget verification."
        )
    else:
        loop_severity = "warning"
        float_loop_message = (
            "A floating-point loop counter can make loop validation target-dependent; check the actual shader compiler before changing it."
        )
        dynamic_loop_message = (
            "This loop bound is not a numeric literal. Verify that the target compiler accepts it before preserving or refactoring the loop."
        )
    _add_limited_line_findings(
        findings,
        float_loop_lines,
        loop_severity,
        "compatibility",
        "float_loop_counter",
        float_loop_message,
        "Additional floating-point loops were omitted from the human-oriented finding list.",
    )
    _add_limited_line_findings(
        findings,
        dynamic_loop_lines,
        loop_severity,
        "compatibility",
        "non_literal_loop_bound",
        dynamic_loop_message,
        "Additional non-literal loop bounds were omitted from the human-oriented finding list.",
    )

    while_lines = _matching_lines(re.compile(r"\bwhile\s*\("), source, line_index)
    _record_feature(features, "while_loop", while_lines)
    if target == "unknown":
        while_severity = "info"
        while_message = (
            "The target shader dialect is unknown. While loops need compiler and frame-budget verification."
        )
    else:
        while_severity = "warning"
        while_message = (
            "While loops need route-specific GLSL ES compiler verification and can be expensive in a full-screen pass."
        )
    _add_limited_line_findings(
        findings,
        while_lines,
        while_severity,
        "compatibility",
        "while_loop",
        while_message,
        "Additional while loops were omitted from the human-oriented finding list.",
    )


def _add_numeric_risk_findings(source, line_index, findings, features):
    parenthesis_pairs = _parenthesis_pairs(source)
    function_rules = {
        "normalize": (
            "zero_normalize",
            "normalize() is undefined for a zero-length vector; guard it only if the original visual permits the behavior change.",
            lambda arguments: True,
        ),
        "inversesqrt": (
            "zero_inversesqrt",
            "inversesqrt() requires a positive non-zero input; verify the expression's lower bound.",
            lambda arguments: True,
        ),
        "sqrt": (
            "sqrt_domain",
            "sqrt() requires a non-negative input; verify its domain before adding clamps.",
            lambda arguments: not arguments
            or _number_literal(arguments[0]) is None
            or _number_literal(arguments[0]) < 0.0,
        ),
        "log": (
            "log_domain",
            "log() requires a positive input; verify its domain before adding an epsilon.",
            lambda arguments: not arguments
            or _number_literal(arguments[0]) is None
            or _number_literal(arguments[0]) <= 0.0,
        ),
        "log2": (
            "log_domain",
            "log2() requires a positive input; verify its domain before adding an epsilon.",
            lambda arguments: not arguments
            or _number_literal(arguments[0]) is None
            or _number_literal(arguments[0]) <= 0.0,
        ),
        "asin": (
            "inverse_trig_domain",
            "asin() requires an input in [-1, 1]; verify the input range before clamping it.",
            lambda arguments: not arguments
            or _number_literal(arguments[0]) is None
            or abs(_number_literal(arguments[0])) > 1.0,
        ),
        "acos": (
            "inverse_trig_domain",
            "acos() requires an input in [-1, 1]; verify the input range before clamping it.",
            lambda arguments: not arguments
            or _number_literal(arguments[0]) is None
            or abs(_number_literal(arguments[0])) > 1.0,
        ),
        "pow": (
            "pow_base_domain",
            "pow() with a non-constant or negative base can produce undefined values for non-integral exponents; review the source range.",
            lambda arguments: not arguments
            or _number_literal(arguments[0]) is None
            or _number_literal(arguments[0]) < 0.0,
        ),
    }

    for function_name, (code, message, predicate) in function_rules.items():
        lines = []
        for _, argument_text, offset in _iter_function_calls(
            source, (function_name,), parenthesis_pairs
        ):
            arguments = _split_top_level_arguments(argument_text)
            if predicate(arguments):
                lines.append(line_index.line_at(offset))
        lines = sorted(set(lines))
        _record_feature(features, function_name, lines)
        _add_limited_line_findings(
            findings,
            lines,
            "warning",
            "numeric",
            code,
            message,
            "Additional calls with this numerical-risk pattern were omitted from the human-oriented finding list.",
        )

    mod_lines = []
    for _, argument_text, offset in _iter_function_calls(
        source, ("mod",), parenthesis_pairs
    ):
        arguments = _split_top_level_arguments(argument_text)
        if len(arguments) < 2:
            mod_lines.append(line_index.line_at(offset))
            continue
        divisor = _number_literal(arguments[1])
        if divisor is None or divisor == 0.0:
            mod_lines.append(line_index.line_at(offset))
    mod_lines = sorted(set(mod_lines))
    _record_feature(features, "mod_with_nonconstant_divisor", mod_lines)
    _add_limited_line_findings(
        findings,
        mod_lines,
        "warning",
        "numeric",
        "mod_divisor",
        "mod() has a non-constant or zero divisor; verify that the divisor cannot become zero.",
        "Additional mod() divisor checks were omitted from the human-oriented finding list.",
    )

    smoothstep_lines = []
    for _, argument_text, offset in _iter_function_calls(
        source, ("smoothstep",), parenthesis_pairs
    ):
        arguments = _split_top_level_arguments(argument_text)
        if len(arguments) < 2:
            continue
        edge0 = _number_literal(arguments[0])
        edge1 = _number_literal(arguments[1])
        if edge0 is not None and edge1 is not None and edge0 >= edge1:
            smoothstep_lines.append(line_index.line_at(offset))
    smoothstep_lines = sorted(set(smoothstep_lines))
    _record_feature(features, "reversed_literal_smoothstep_edges", smoothstep_lines)
    _add_limited_line_findings(
        findings,
        smoothstep_lines,
        "warning",
        "numeric",
        "smoothstep_edge_order",
        "smoothstep() has literal edge0 >= edge1. That ordering is undefined by the GLSL specification, even if a source effect relies on it.",
        "Additional reversed smoothstep() edges were omitted from the human-oriented finding list.",
    )

    division_operator_pattern = re.compile(r"(?<!/)/(?![=/])")
    division_lines = []
    for match in division_operator_pattern.finditer(source):
        line_start = source.rfind("\n", 0, match.start()) + 1
        if source[line_start:match.start()].lstrip().startswith("#"):
            continue
        cursor = match.end()
        while cursor < len(source) and source[cursor].isspace():
            cursor += 1
        if cursor >= len(source):
            continue

        requires_review = False
        if source[cursor] == "(":
            closing_offset = parenthesis_pairs.get(cursor)
            if closing_offset is None:
                requires_review = True
            else:
                denominator = source[cursor + 1 : closing_offset].strip()
                literal = _number_literal(denominator)
                requires_review = literal is None or literal == 0.0
        else:
            identifier = re.match(r"[A-Za-z_]\w*", source[cursor:])
            if identifier is not None:
                requires_review = True
            else:
                number = NUMBER_PREFIX_RE.match(source[cursor:])
                requires_review = (
                    number is not None
                    and _number_literal(number.group(0)) == 0.0
                )

        if requires_review:
            division_lines.append(line_index.line_at(match.start()))
    division_lines = sorted(set(division_lines))
    _record_feature(features, "division_with_nonliteral_denominator", division_lines)
    _add_limited_line_findings(
        findings,
        division_lines,
        "warning",
        "numeric",
        "nonliteral_division_denominator",
        "A division uses a variable or expression denominator. Verify its non-zero invariant before adding an epsilon, because that can alter the effect.",
        "Additional non-literal divisions were omitted from the human-oriented finding list.",
    )


def analyze_source(source, path="<memory>", target="unknown"):
    """Return a structured, read-only heuristic report for one source string."""

    target = _validate_target(target)
    source_characters = len(source)
    if source_characters > MAX_SOURCE_CHARACTERS:
        inferred_pass = infer_pass_name(path, "")
        return _unscanned_report(
            path,
            inferred_pass,
            "skipped",
            target,
            "source_too_large",
            (
                "The in-memory source exceeds the {0}-byte safety limit and was "
                "not scanned."
            ).format(MAX_SOURCE_BYTES),
            source_characters,
        )

    source_bytes = len(source.encode("utf-8", "surrogatepass"))
    if source_bytes > MAX_SOURCE_BYTES:
        inferred_pass = infer_pass_name(path, "")
        return _unscanned_report(
            path,
            inferred_pass,
            "skipped",
            target,
            "source_too_large",
            (
                "The in-memory source is {0} bytes, above the {1}-byte safety "
                "limit and was not scanned."
            ).format(source_bytes, MAX_SOURCE_BYTES),
            source_characters,
        )

    sanitized = strip_comments(source)
    line_index = LineIndex(sanitized)
    findings = Findings()
    features = []

    inferred_pass = infer_pass_name(path, source)
    parenthesis_pairs = _parenthesis_pairs(sanitized)
    main_image_lines = _function_definition_lines(
        sanitized, line_index, "mainImage", parenthesis_pairs
    )
    main_lines = _function_definition_lines(
        sanitized, line_index, "main", parenthesis_pairs
    )
    entrypoints = []
    if main_image_lines:
        entrypoints.append("mainImage")
        _add_limited_line_findings(
            findings,
            main_image_lines,
            "info",
            "entrypoint",
            "shadertoy_mainImage",
            "Shadertoy-style mainImage() was found; a route-specific wrapper and uniform mapping are still required.",
            "Additional mainImage() declarations were omitted from the human-oriented finding list.",
        )
    if main_lines:
        entrypoints.append("main")
        _add_limited_line_findings(
            findings,
            main_lines,
            "info",
            "entrypoint",
            "direct_main",
            "A direct main() shader entry point was found; verify the target stage and host interface before reuse.",
            "Additional main() declarations were omitted from the human-oriented finding list.",
        )
    if not entrypoints:
        if inferred_pass == "Common":
            findings.add(
                "info",
                "entrypoint",
                "common_without_entrypoint",
                1,
                "No executable entry point was found. This is consistent with a Shadertoy Common pass, but pass wiring still needs verification.",
            )
        else:
            findings.add(
                "warning",
                "entrypoint",
                "entrypoint_not_found",
                1,
                "No mainImage() or main() entry point was found. The source may be incomplete, a Common pass, or require a different entry convention.",
            )

    uniform_declarations, declaration_spans = _uniform_declarations(
        sanitized, line_index
    )
    shadertoy_references = _shadertoy_references(
        sanitized, line_index, declaration_spans
    )
    channels = []
    for index in range(4):
        name = "iChannel{0}".format(index)
        if name in shadertoy_references:
            channels.append(
                {
                    "name": name,
                    "index": index,
                    "lines": shadertoy_references[name],
                }
            )
            _add_limited_line_findings(
                findings,
                shadertoy_references[name],
                "info",
                "shadertoy_input",
                "ichannel_reference",
                "{0} is referenced. Map its texture or feedback buffer through the actual NetEase material and pass configuration.".format(
                    name
                ),
                "Additional channel references were omitted from the human-oriented finding list.",
            )

    for name in ("iResolution", "iTime", "iMouse", "iFrame", "iDate"):
        if name in shadertoy_references:
            _add_limited_line_findings(
                findings,
                shadertoy_references[name],
                "info",
                "shadertoy_input",
                "shadertoy_uniform_reference",
                "{0} is referenced. Its NetEase equivalent must be verified from the real render route; do not assume a uniform name.".format(
                    name
                ),
                "Additional Shadertoy uniform references were omitted from the human-oriented finding list.",
            )

    _add_compatibility_findings(
        sanitized, line_index, target, findings, features
    )
    _add_numeric_risk_findings(sanitized, line_index, findings, features)

    report = _new_report(
        path, inferred_pass, "analyzed", target, source_characters
    )
    report.update(
        {
            "entrypoints": entrypoints,
            "shadertoy_references": shadertoy_references,
            "channels": channels,
            "uniform_declarations": uniform_declarations,
            "compatibility_features": features,
            "findings": findings.sorted_items(),
            "disclaimer": (
                "Read-only heuristic source scan only. It did not compile, link, load, or run this shader in NetEase Minecraft, MCDK, or any GPU runtime."
            ),
        }
    )
    return report


def _read_source(path):
    try:
        source_size = path.stat().st_size
    except OSError as error:
        return (
            None,
            "source_read_error",
            "Unable to inspect source size: {0}".format(error),
        )

    if source_size > MAX_SOURCE_BYTES:
        return (
            None,
            "source_too_large",
            (
                "The source is {0} bytes, above the {1}-byte safety limit for "
                "this heuristic scanner."
            ).format(source_size, MAX_SOURCE_BYTES),
        )

    try:
        raw = path.read_bytes()
    except OSError as error:
        return (
            None,
            "source_read_error",
            "Unable to read source: {0}".format(error),
        )

    if len(raw) > MAX_SOURCE_BYTES:
        return (
            None,
            "source_too_large",
            (
                "The source grew above the {0}-byte safety limit while it was "
                "being read."
            ).format(MAX_SOURCE_BYTES),
        )

    if b"\x00" in raw:
        return (
            None,
            "source_read_error",
            "The file contains NUL bytes and was not treated as GLSL text.",
        )

    for encoding in ("utf-8-sig", "utf-8", "gb18030"):
        try:
            decoded = raw.decode(encoding)
        except UnicodeDecodeError:
            continue
        if len(decoded) > MAX_SOURCE_CHARACTERS:
            return (
                None,
                "source_too_large",
                "The decoded source exceeds the {0}-character safety limit.".format(
                    MAX_SOURCE_CHARACTERS
                ),
            )
        return decoded, None, None
    return (
        None,
        "source_read_error",
        "The file could not be decoded as UTF-8 or GB18030 text.",
    )


def analyze_path(path_text, target="unknown"):
    """Analyze one path with the same target validation as in-memory scans."""

    target = _validate_target(target)
    path = Path(path_text)
    inferred_pass = infer_pass_name(path, "")
    if not path.is_file():
        return _unscanned_report(
            path,
            inferred_pass,
            "unreadable",
            target,
            "source_not_file",
            "The supplied path is not a readable regular file.",
        )

    source, error_code, error_message = _read_source(path)
    if error_code:
        status = "skipped" if error_code == "source_too_large" else "unreadable"
        return _unscanned_report(
            path, inferred_pass, status, target, error_code, error_message
        )
    return analyze_source(source, path, target)


def build_document(paths, target="unknown"):
    """Build a batch document from a non-empty, materialized iterable of paths."""

    requested_paths = tuple(paths)
    target = _validate_target(target)
    if not requested_paths:
        raise ValueError("paths must contain at least one source path")

    reports = [analyze_path(path, target) for path in requested_paths]
    finding_counts = Counter()
    for report in reports:
        for finding in report.get("findings", ()):
            finding_counts[finding["severity"]] += 1
    analyzed = sum(1 for report in reports if report["status"] == "analyzed")
    skipped = sum(1 for report in reports if report["status"] == "skipped")
    unreadable = sum(1 for report in reports if report["status"] == "unreadable")
    if analyzed == len(reports):
        status = "completed"
    elif unreadable == len(reports):
        status = "failed"
    else:
        status = "partial"
    return {
        "tool": TOOL_NAME,
        "tool_version": TOOL_VERSION,
        "schema_version": SCHEMA_VERSION,
        "analysis_scope": (
            "Read-only heuristic source scan. This is not compilation, shader loading, MCDK testing, or in-game validation."
        ),
        "target_baseline": target,
        "status": status,
        "files": reports,
        "summary": {
            "files_requested": len(requested_paths),
            "files_analyzed": analyzed,
            "files_skipped": skipped,
            "files_unreadable": unreadable,
            "findings_by_severity": dict(
                (severity, finding_counts.get(severity, 0))
                for severity in ("error", "warning", "info")
            ),
        },
    }


def _print_human(document):
    print("Read-only Shadertoy / GLSL source scan")
    print("Report schema: {0}".format(document["schema_version"]))
    print("Target baseline: {0}".format(document["target_baseline"]))
    print(
        "Important: this is heuristic analysis only; it did not compile, load, or run a shader."
    )
    print()

    for report in document["files"]:
        print("{0} [{1}]".format(report["path"], report["status"]))
        print("  Inferred pass: {0}".format(report["pass_name"]))
        entrypoints = report.get("entrypoints", ())
        print(
            "  Entrypoints: {0}".format(
                ", ".join(entrypoints) if entrypoints else "none found"
            )
        )

        references = report.get("shadertoy_references", {})
        if references:
            rendered_references = []
            for name in sorted(references):
                rendered_references.append(
                    "{0} (L{1})".format(
                        name, ",".join(str(line) for line in references[name])
                    )
                )
            print("  Shadertoy references: {0}".format("; ".join(rendered_references)))
        else:
            print("  Shadertoy references: none found")

        declarations = report.get("uniform_declarations", ())
        if declarations:
            rendered_uniforms = [
                "{0} {1} (L{2})".format(
                    item["type"], item["name"], item["line"]
                )
                for item in declarations
            ]
            print("  Declared uniforms: {0}".format("; ".join(rendered_uniforms)))

        findings = report.get("findings", ())
        if findings:
            print("  Findings:")
            for finding in findings:
                print(
                    "    {0:<7} L{1:<4} [{2}/{3}] {4}".format(
                        finding["severity"].upper(),
                        finding["line"],
                        finding["category"],
                        finding["code"],
                        finding["message"],
                    )
                )
        else:
            print("  Findings: none")
        print()

    summary = document["summary"]
    counts = summary["findings_by_severity"]
    print(
        "Scan result: {0}; {1}/{2} file(s) read, {3} skipped, {4} unreadable. "
        "Findings: {5} error, {6} warning, {7} info.".format(
            document["status"],
            summary["files_analyzed"],
            summary["files_requested"],
            summary["files_skipped"],
            summary["files_unreadable"],
            counts["error"],
            counts["warning"],
            counts["info"],
        )
    )
    print(
        "Exit status 0 means every requested source was scanned, not that a shader compiled or ran. Exit status 1 means one or more paths were unreadable or skipped."
    )


def parse_arguments(argv):
    parser = argparse.ArgumentParser(
        description=(
            "Read one or more Shadertoy/GLSL source files and report conservative "
            "NetEase-porting cues. The tool is read-only and never compiles or runs shaders."
        ),
        epilog=(
            "Exit status 0 means all requested files were scanned. It does not mean "
            "the source compiled, linked, loaded, or ran. Exit status 1 means at "
            "least one supplied path could not be read or was skipped."
        ),
    )
    parser.add_argument(
        "sources",
        nargs="+",
        metavar="SOURCE",
        help="One or more source files to inspect. They are read but never modified.",
    )
    parser.add_argument(
        "--json",
        action="store_true",
        help="Emit a machine-readable JSON report to stdout instead of human text.",
    )
    parser.add_argument(
        "--target",
        choices=VALID_TARGETS,
        default="unknown",
        help=(
            "Compatibility baseline for warnings (default: unknown). This is an "
            "analysis assumption, not a statement about the project's actual NetEase target."
        ),
    )
    return parser.parse_args(argv)


def _configure_cli_stdout():
    """Configure only the script process's stdout for legacy Windows consoles."""

    if hasattr(sys.stdout, "reconfigure"):
        try:
            sys.stdout.reconfigure(errors="backslashreplace")
        except (AttributeError, OSError, ValueError):
            pass


def main(argv=None):
    arguments = parse_arguments(argv)
    document = build_document(arguments.sources, arguments.target)
    if arguments.json:
        json.dump(document, sys.stdout, ensure_ascii=True, indent=2, sort_keys=True)
        sys.stdout.write("\n")
    else:
        _print_human(document)
    return (
        0
        if document["summary"]["files_analyzed"]
        == document["summary"]["files_requested"]
        else 1
    )


if __name__ == "__main__":
    _configure_cli_stdout()
    sys.exit(main())
