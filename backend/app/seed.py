"""First-run seed: the Fastener part type, company standards presets, and prompt v1."""

import logging

from sqlalchemy import select
from sqlalchemy.orm import Session

from .models import FieldDefinition, PartType, PromptVersion, StandardRule
from .services import prompt_builder

logger = logging.getLogger(__name__)

FASTENER_FIELDS = [
    ("partNumber", "Part Number", "The primary part number, typically in the title block (format XXXXXYYAA, e.g. 06513832AA). Prefer the EBOM PART NUMBER cell of the title block.", "06513832AA, 06508183AA"),
    ("revision", "Revision", "Drawing revision. May be a numbered revision (e.g. 001) or a CSO date. Report numbered revisions as 'Revision XXX'.", "Revision 001, CSO 4/29/22"),
    ("thread", "Thread Specification", "Thread size and pitch, e.g. M12-1.25. Preserve the pitch exactly as printed, including trailing zeros.", "M12-1.25, M6-1 MATpoint Standard"),
    ("length", "Length", "Nominal shank/overall length in millimetres as dimensioned on the drawing.", "42, X 30, X 106"),
    ("drive", "Drive Type", "Drive/recess type and size. E-sizes are external 6-lobe (e.g. E18 External 6 Lobe); T-sizes are internal (e.g. T30 6 Lobe). Verify single vs double digit sizes carefully (E8 vs E18).", "T30 6 Lobe, E8 External 6 Lobe"),
    ("headStyle", "Head Style", "Head style, e.g. Pan Head, Flange Head, Indented Hex Head. Include qualifiers such as 'Indented' when shown.", "Pan Head, Flange Head, Indented Hex Head"),
    ("partType", "Part Type", "The specific part category, decoded from the ITEM NAME line (usually in the title block). Decode the abbreviations: 'SC' = Screw; 'SC WA' / 'SC&WA' = Screw Assembly (screw with captive washer); a point suffix makes the type more specific: 'MAT PT' = Mat Point, 'HEADER PT' / 'HEADER.PT' = Header Point, 'KUKA PT' = Kuka Point; tamper-proof markings = Tamper Proof. Output the MOST specific category the printed text supports — never plain 'Screw' when an assembly or point type is printed. Examples: 'SC WA TRUSS HD FLAT WASH MAT PT.' -> 'Screw Assembly Mat Point'; 'SC/PAN.HD.LK HEADER.PT LOCK.PATCH6-LOBE.REC' -> 'Screw With Header Point'. Possible values include: Screw, Screw Assembly, Screw With Header Point, Screw With Kuka Point, Screw Assembly Mat Point, Screw Assembly Header Point, Tamper Proof Screw Assembly, Bolt.", "Screw Assembly Mat Point, Screw With Header Point, Tamper Proof Screw Assembly"),
    ("material", "Material Specification", "Material/property class, e.g. Class 12.9, including the governing spec reference when printed.", "Class 12.9 Per MS.50077, Class 9.8A"),
    ("finish", "Finish / Coating", "Surface finish or coating spec(s), e.g. PS.50035 Type 2. Combine base coat and patch/adhesive coatings with ' + '.", "PS.50035 Type 2, PS 12182 Black"),
    ("washer", "Washer", "Captive washer details when the part is an assembly (type and outer diameter). Null when there is no washer.", "Flat Washer 20MM OD"),
]

STANDARDS_PRESETS = [
    ("Head style nomenclature", "Treat 'Truss Head' and 'Pan Head' as equivalent; always output 'Pan Head'.",
     "Blueprints say 'TRUSS HD' but the company parts catalog standardises on 'Pan Head'."),
    ("Drive nomenclature", "Use '6 Lobe' naming, not 'Torx' (e.g. 'T30 6 Lobe', never 'T30 Torx').",
     "Blueprints mix both: 'T30 TORX 6-LOBED RECESS'. The catalog uses 6 Lobe."),
    ("Hex head without recess", "For hex heads with no drive recess, leave the drive field blank (do not write 'Unslotted').",
     "A plain hex head has no drive feature to name."),
    ("Indented qualifier", "Include the 'Indented' qualifier in head style whenever the drawing shows an indented head.",
     "Ground truth contains 'Indented Hex Head'; dropping the qualifier loses information."),
    ("Material MS prefix", "Strip MS-spec references from material: output 'Class X.X' only (e.g. 'Class 12.9', not 'Class 12.9 Per MS-80077').",
     "Engineer decision: the class is the useful value; the MS reference lives on the drawing."),
    ("Revision format", "Numbered revisions are output as 'Revision XXX'. When only a CSO date exists, output it verbatim (e.g. 'CSO 4/29/22').",
     "Two competing formats exist in ground truth."),
    ("Thread pitch trailing zeros", "Match the blueprint exactly for thread pitch — keep trailing zeros as printed (M10-1.50 stays M10-1.50).",
     "Minor format difference that breaks string comparison against ground truth."),
    ("Multiple coatings", "When a part has multiple coatings (base + adhesive/patch), combine them with ' + ' in a single finish value.",
     "Parts often carry a base coat plus a thread patch; both matter."),
]


def seed(db: Session) -> None:
    if db.scalars(select(PartType)).first() is not None:
        return
    logger.info("Seeding initial configuration")

    fastener = PartType(
        name="Fastener",
        description="Screws, bolts and screw assemblies. The default part type for the POC blueprints.",
    )
    db.add(fastener)
    db.flush()

    for i, (key, label, desc, example) in enumerate(FASTENER_FIELDS):
        db.add(FieldDefinition(
            part_type_id=fastener.id, key=key, label=label,
            description=desc, example=example, sort_order=i,
        ))

    for i, (title, rule, context) in enumerate(STANDARDS_PRESETS):
        db.add(StandardRule(title=title, rule=rule, context=context, sort_order=i))

    db.flush()
    db.add(PromptVersion(
        version_number=1,
        label="v1.0",
        notes="Initial prompt assembled from the seeded Fastener fields and company standards presets.",
        snapshot=prompt_builder.build_snapshot(db),
    ))
    db.commit()
