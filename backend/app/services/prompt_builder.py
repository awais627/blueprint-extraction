"""Dynamic extraction prompt assembly.

The extraction "prompt" for the Datalab Extract API is a JSON schema whose
descriptions carry the instructions. It is assembled at runtime from:

1. Part type field definitions (which fields, with hints)
2. Active company standards (formatting rules)
3. Accumulated corrections (known-issue warnings, grouped by field)
"""

from collections import Counter
from sqlalchemy import select
from sqlalchemy.orm import Session

from ..models import Correction, Document, FieldDefinition, PartType, StandardRule

MAX_WARNINGS_PER_FIELD = 3


def get_active_standards(db: Session) -> list[StandardRule]:
    return list(
        db.scalars(
            select(StandardRule).where(StandardRule.active.is_(True)).order_by(StandardRule.sort_order)
        )
    )


def get_correction_warnings(db: Session) -> dict[str, list[str]]:
    """Group correction reasons by field key -> warning lines, most frequent first."""
    corrections = list(
        db.scalars(
            select(Correction)
            .where(Correction.document_id.in_(select(Document.id)))
            .order_by(Correction.created_at.desc())
        )
    )
    by_field: dict[str, list[tuple[str, str | None]]] = {}
    for c in corrections:
        reason = c.reason.strip()
        if not reason:
            # no explanation typed — the wrong->right values are still a lesson
            if not (c.corrected_value or "").strip():
                continue
            original = (c.original_value or "").strip() or "(blank)"
            reason = f"AI answered '{original}' here; the engineer corrected it to '{c.corrected_value}'"
        by_field.setdefault(c.field_key, []).append((reason, c.source_snippet))

    warnings: dict[str, list[str]] = {}
    for key, items in by_field.items():
        # Deduplicate near-identical reasons, keep frequency for emphasis
        counts = Counter(reason for reason, _ in items)
        # verbatim printed text under the engineer's marked box, newest first
        snippets: dict[str, str] = {}
        for reason, snippet in items:
            if snippet and reason not in snippets:
                snippets[reason] = snippet
        lines = []
        for reason, n in counts.most_common(MAX_WARNINGS_PER_FIELD):
            suffix = f" (seen {n} times)" if n > 1 else ""
            hint = ""
            if reason in snippets:
                hint = f" [engineer marked where the correct value is printed; the text there reads: '{snippets[reason]}']"
            lines.append(f"{reason}{suffix}{hint}")
        warnings[key] = lines
    return warnings


def build_field_description(field: FieldDefinition, warnings: dict[str, list[str]]) -> str:
    parts = [field.description.strip() or field.label]
    if field.example:
        parts.append(f"Examples: {field.example}")
    field_warnings = warnings.get(field.key, [])
    if field_warnings:
        parts.append("KNOWN ISSUES — PAY ATTENTION: " + " | ".join(field_warnings))
    return " ".join(p for p in parts if p)


def build_root_description(part_type: PartType, standards: list[StandardRule]) -> str:
    lines = [
        f"Analyze this engineering blueprint and extract the following attributes for a {part_type.name}.",
        "Read values exactly as printed on the drawing unless a formatting rule below says otherwise.",
        "If an attribute is not present on the drawing, return null for it.",
        "Every attribute has a companion *_source property: fill it with the exact text as printed on the "
        "document that the value was read or derived from — verbatim, character-for-character, keeping "
        "abbreviations, punctuation and case (e.g. 'CONE.WASH' for a Cone Washer, 'SC&WA' for a Screw "
        "Assembly). Never normalize or expand the *_source text.",
    ]
    if standards:
        lines.append("")
        lines.append("COMPANY FORMATTING RULES:")
        for i, s in enumerate(standards, 1):
            lines.append(f"{i}. {s.rule.strip()}")
    return "\n".join(lines)


def build_page_schema(db: Session, part_type: PartType) -> dict:
    """Assemble the JSON schema sent to the Datalab Extract API."""
    standards = get_active_standards(db)
    warnings = get_correction_warnings(db)
    active_fields = [f for f in part_type.fields if f.active]

    properties = {}
    for field in active_fields:
        properties[field.key] = {
            "type": ["string", "null"],
            "description": build_field_description(field, warnings),
        }
        # verbatim source text lets the app anchor the bounding box to the exact
        # printed characters even when the value itself is normalized/inferred
        properties[f"{field.key}_source"] = {
            "type": ["string", "null"],
            "description": (
                f"The exact text printed on the document from which '{field.label}' was read or derived — "
                "verbatim, character-for-character, including abbreviations, punctuation and case, exactly "
                "as it appears (do NOT normalize, expand or reformat it). Null if the value was not read "
                "from printed text."
            ),
        }

    return {
        "type": "object",
        "title": f"{part_type.name}Extraction",
        "description": build_root_description(part_type, standards),
        "properties": properties,
    }


def build_prompt_text(db: Session, part_type: PartType) -> str:
    """Human-readable rendering of the assembled prompt for the Prompt Studio."""
    standards = get_active_standards(db)
    warnings = get_correction_warnings(db)
    active_fields = [f for f in part_type.fields if f.active]

    lines = [
        f"Analyze this engineering blueprint and extract the following attributes for a {part_type.name}:",
        "",
    ]
    for f in active_fields:
        desc = f.description.strip() or f.label
        example = f" (e.g., {f.example})" if f.example else ""
        lines.append(f"- {f.label} [{f.key}]: {desc}{example}")

    lines += ["", "COMPANY FORMATTING RULES:"]
    if standards:
        for i, s in enumerate(standards, 1):
            lines.append(f"{i}. {s.rule.strip()}")
    else:
        lines.append("(none configured)")

    lines += ["", "KNOWN ISSUES — PAY ATTENTION TO THESE:"]
    any_warning = False
    for f in active_fields:
        for w in warnings.get(f.key, []):
            lines.append(f"- {f.label}: {w}")
            any_warning = True
    if not any_warning:
        lines.append("(no correction feedback accumulated yet)")

    lines += [
        "",
        "Return the data as a JSON object with these keys: "
        + ", ".join(f.key for f in active_fields)
        + ". Use null for attributes not present on the drawing.",
        "For every attribute also fill its companion <key>_source property with the exact printed text the "
        "value came from, verbatim (e.g. washer='Cone Washer' with washer_source='CONE.WASH').",
    ]
    return "\n".join(lines)


def build_snapshot(db: Session) -> dict:
    """Snapshot of assembled prompts for every part type, stored on publish."""
    part_types = list(db.scalars(select(PartType).order_by(PartType.id)))
    return {
        "part_types": {
            pt.name: {
                "prompt_text": build_prompt_text(db, pt),
                "page_schema": build_page_schema(db, pt),
            }
            for pt in part_types
        }
    }
