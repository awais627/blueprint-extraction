from collections import Counter

from fastapi import APIRouter, Depends
from sqlalchemy import select, text
from sqlalchemy.orm import Session

from ..config import settings
from ..database import get_db
from ..models import Correction, Document, ExtractedField, PromptVersion
from ..routers.prompts import _version_stats
from ..schemas import (
    CorrectionOut,
    DashboardOut,
    DashboardStats,
    ErrorPattern,
    MetaOut,
    VersionAccuracy,
)

router = APIRouter(prefix="/api", tags=["dashboard"])


@router.get("/dashboard", response_model=DashboardOut)
def dashboard(db: Session = Depends(get_db)):
    docs = db.scalars(select(Document)).all()
    fields = db.scalars(select(ExtractedField)).all()
    corrections = db.scalars(
        select(Correction)
        .where(Correction.document_id.in_(select(Document.id)))
        .order_by(Correction.created_at.desc())
    ).all()

    verified = sum(1 for f in fields if f.status == "verified")
    corrected = sum(1 for f in fields if f.status == "corrected")
    reviewed = verified + corrected
    confs = [f.confidence for f in fields if f.confidence is not None]

    stats = DashboardStats(
        documents_total=len(docs),
        documents_completed=sum(1 for d in docs if d.status == "completed"),
        documents_failed=sum(1 for d in docs if d.status == "failed"),
        fields_total=len(fields),
        fields_verified=verified,
        fields_corrected=corrected,
        fields_unverified=sum(1 for f in fields if f.status == "unverified"),
        corrections_total=len(corrections),
        overall_accuracy=verified / reviewed if reviewed else None,
        avg_confidence=sum(confs) / len(confs) if confs else None,
    )

    # error patterns: corrections grouped by field
    by_field: dict[str, list[Correction]] = {}
    for c in corrections:
        by_field.setdefault(c.field_key, []).append(c)
    patterns = []
    for key, items in by_field.items():
        categories = [c for c, _ in Counter(i.category for i in items if i.category).most_common(3)]
        patterns.append(ErrorPattern(
            field_key=key,
            field_label=items[0].field_label or key,
            count=len(items),
            last_reason=next((i.reason for i in items if i.reason), ""),
            categories=categories,
        ))
    patterns.sort(key=lambda p: p.count, reverse=True)

    versions = db.scalars(select(PromptVersion).order_by(PromptVersion.version_number)).all()
    version_accuracy = []
    for v in versions:
        _, reviewed_v, accuracy = _version_stats(db, v)
        version_accuracy.append(VersionAccuracy(
            id=v.id, label=v.label, created_at=v.created_at,
            fields_reviewed=reviewed_v, accuracy=accuracy,
        ))

    return DashboardOut(
        stats=stats,
        error_patterns=patterns,
        version_accuracy=version_accuracy,
        recent_corrections=[CorrectionOut.model_validate(c) for c in corrections[:20]],
    )


@router.get("/meta", response_model=MetaOut)
def meta():
    return MetaOut(
        mode=settings.resolved_mode,
        extraction_mode=settings.extraction_mode,
        has_api_key=bool(settings.datalab_api_key),
    )


@router.get("/warmup")
def warmup(db: Session = Depends(get_db)):
    """Touch the DB so Neon's compute resumes before the user's first real query.

    Kept separate from /api/health so DO's readiness probe never depends on
    Neon being awake or reachable.
    """
    db.execute(text("SELECT 1"))
    return {"status": "ok"}
