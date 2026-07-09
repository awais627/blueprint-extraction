import json
import logging
from pathlib import Path

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy import select
from sqlalchemy.orm import Session

from ..database import get_db
from ..models import Document, ExtractedField
from ..schemas import (
    BBox,
    CorrectionIn,
    CorrectionOut,
    ExtractedFieldOut,
    FieldStatusPatch,
    SnippetPreviewIn,
    SnippetPreviewOut,
)
from ..models import Correction
from ..services import merge

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api", tags=["fields"])


def _restore_field_location(field: ExtractedField, correction: Correction) -> None:
    """Undo create_correction's overwrite of match_quality/bbox/locations, if it anchored one."""
    if correction.prev_match_quality is None:
        return
    field.match_quality = correction.prev_match_quality
    field.page = correction.prev_page
    field.bbox_x = correction.prev_bbox_x
    field.bbox_y = correction.prev_bbox_y
    field.bbox_w = correction.prev_bbox_w
    field.bbox_h = correction.prev_bbox_h
    field.locations = correction.prev_locations or []


@router.patch("/fields/{field_id}", response_model=ExtractedFieldOut)
def set_field_status(field_id: int, patch: FieldStatusPatch, db: Session = Depends(get_db)):
    field = db.get(ExtractedField, field_id)
    if field is None:
        raise HTTPException(404, "Field not found")
    if field.status == "corrected" and patch.status != "corrected":
        # undo the correction: restore whatever match info it overwrote and drop the
        # record so it stops surfacing in the corrections list, dashboard, and prompt warnings
        corrections = db.scalars(
            select(Correction).where(Correction.field_id == field.id).order_by(Correction.created_at.desc())
        ).all()
        for i, correction in enumerate(corrections):
            if i == 0:
                _restore_field_location(field, correction)
            db.delete(correction)
    field.status = patch.status
    if patch.status != "corrected":
        field.corrected_value = None
    db.commit()
    return field


def _region_snippet(field: ExtractedField, bbox: BBox) -> str | None:
    """Printed text under the engineer's marked box, from the run's OCR artifact."""
    try:
        if field.extraction is None or not field.extraction.artifacts_dir:
            return None
        ocr_path = Path(field.extraction.artifacts_dir) / "ocr.json"
        if not ocr_path.exists():
            return None
        payload = json.loads(ocr_path.read_text(), strict=False)
        text = merge.region_text(payload, bbox.page, (bbox.x, bbox.y, bbox.x + bbox.w, bbox.y + bbox.h))
        return text[:300] if text else None
    except Exception:
        logger.exception("Could not read OCR snippet for field %s — saving correction without it", field.id)
        return None


@router.post("/corrections", response_model=CorrectionOut, status_code=201)
def create_correction(payload: CorrectionIn, db: Session = Depends(get_db)):
    field = db.get(ExtractedField, payload.field_id)
    if field is None:
        raise HTTPException(404, "Field not found")
    doc = db.get(Document, field.document_id)

    correction = Correction(
        field_id=field.id,
        document_id=field.document_id,
        document_name=doc.filename if doc else "",
        field_key=field.field_key,
        field_label=field.label,
        original_value=field.value,
        corrected_value=payload.corrected_value.strip(),
        reason=payload.reason.strip(),
        category=payload.category.strip(),
        prompt_version_id=field.extraction.prompt_version_id if field.extraction else None,
    )
    if payload.bbox is not None:
        correction.page = payload.bbox.page
        correction.bbox_x = payload.bbox.x
        correction.bbox_y = payload.bbox.y
        correction.bbox_w = payload.bbox.w
        correction.bbox_h = payload.bbox.h
        correction.source_snippet = _region_snippet(field, payload.bbox)

        # snapshot the field's current match info so a revert can restore it
        correction.prev_match_quality = field.match_quality
        correction.prev_page = field.page
        correction.prev_bbox_x = field.bbox_x
        correction.prev_bbox_y = field.bbox_y
        correction.prev_bbox_w = field.bbox_w
        correction.prev_bbox_h = field.bbox_h
        correction.prev_locations = field.locations

        # the engineer's marked box is better location info than a wrong match
        field.page = payload.bbox.page
        field.bbox_x = payload.bbox.x
        field.bbox_y = payload.bbox.y
        field.bbox_w = payload.bbox.w
        field.bbox_h = payload.bbox.h
        field.match_quality = "anchor"
        loc = {"page": payload.bbox.page, "x": payload.bbox.x, "y": payload.bbox.y,
               "w": payload.bbox.w, "h": payload.bbox.h, "q": "anchor"}
        field.locations = [loc] + [
            l for l in (field.locations or [])
            if not (l.get("page") == loc["page"] and merge._xywh_overlap(l, loc))
        ]

    field.status = "corrected"
    field.corrected_value = correction.corrected_value

    db.add(correction)
    db.commit()
    return correction


@router.post("/corrections/preview-snippet", response_model=SnippetPreviewOut)
def preview_snippet(payload: SnippetPreviewIn, db: Session = Depends(get_db)):
    """Printed text under an engineer's marked box, before the correction is saved.

    Uses the same OCR lookup as create_correction so the reason auto-generated for
    the extraction prompt can be previewed live in the review UI.
    """
    field = db.get(ExtractedField, payload.field_id)
    if field is None:
        raise HTTPException(404, "Field not found")
    return SnippetPreviewOut(source_snippet=_region_snippet(field, payload.bbox))


@router.get("/corrections", response_model=list[CorrectionOut])
def list_corrections(db: Session = Depends(get_db)):
    return db.scalars(
        select(Correction)
        .where(Correction.document_id.in_(select(Document.id)))
        .order_by(Correction.created_at.desc())
    ).all()


@router.delete("/corrections/{correction_id}", status_code=204)
def delete_correction(correction_id: int, db: Session = Depends(get_db)):
    correction = db.get(Correction, correction_id)
    if correction is None:
        raise HTTPException(404, "Correction not found")
    if correction.field_id is not None:
        field = db.get(ExtractedField, correction.field_id)
        if field is not None and field.status == "corrected":
            field.status = "unverified"
            field.corrected_value = None
            _restore_field_location(field, correction)
    db.delete(correction)
    db.commit()
