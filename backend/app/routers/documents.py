import shutil

from fastapi import APIRouter, Depends, File, Form, HTTPException, UploadFile
from fastapi.responses import FileResponse
from sqlalchemy import delete, select
from sqlalchemy.orm import Session, joinedload, selectinload

from ..config import settings
from ..database import get_db
from ..models import Correction, Document, ExtractedField, Extraction, PartType
from ..schemas import DocumentDetail, DocumentOut, ExtractedFieldOut
from ..services import pipeline

router = APIRouter(prefix="/api/documents", tags=["documents"])

ALLOWED_TYPES = {
    "application/pdf": ".pdf",
    "image/png": ".png",
    "image/jpeg": ".jpg",
    "image/webp": ".webp",
}


def _doc_out(doc: Document, fields: list[ExtractedField]) -> DocumentOut:
    confs = [f.confidence for f in fields if f.confidence is not None]
    return DocumentOut(
        id=doc.id,
        filename=doc.filename,
        status=doc.status,
        phase=doc.phase,
        error=doc.error,
        page_count=doc.page_count,
        part_number=doc.part_number,
        part_type_id=doc.part_type_id,
        part_type_name=doc.part_type.name if doc.part_type else None,
        created_at=doc.created_at,
        processed_at=doc.processed_at,
        fields_total=len(fields),
        fields_verified=sum(1 for f in fields if f.status == "verified"),
        fields_corrected=sum(1 for f in fields if f.status == "corrected"),
        avg_confidence=sum(confs) / len(confs) if confs else None,
    )


def _latest_fields(doc: Document) -> list[ExtractedField]:
    if not doc.extractions:
        return []
    return doc.extractions[-1].fields


@router.get("", response_model=list[DocumentOut])
def list_documents(db: Session = Depends(get_db)):
    docs = db.scalars(
        select(Document)
        .options(
            joinedload(Document.part_type),
            selectinload(Document.extractions).selectinload(Extraction.fields),
        )
        .order_by(Document.created_at.desc())
    ).all()
    return [_doc_out(d, _latest_fields(d)) for d in docs]


@router.post("", response_model=list[DocumentOut], status_code=201)
def upload_documents(
    files: list[UploadFile] = File(...),
    part_type_id: int = Form(...),
    db: Session = Depends(get_db),
):
    part_type = db.get(PartType, part_type_id)
    if part_type is None:
        raise HTTPException(404, "Part type not found")

    settings.uploads_dir.mkdir(parents=True, exist_ok=True)
    created: list[Document] = []
    for upload in files:
        content_type = upload.content_type or "application/pdf"
        if content_type not in ALLOWED_TYPES:
            raise HTTPException(415, f"Unsupported file type: {content_type}")
        content = upload.file.read()
        doc = Document(
            filename=upload.filename or "document.pdf",
            stored_path="",
            file_data=content,
            content_type=content_type,
            part_type_id=part_type_id,
        )
        db.add(doc)
        db.flush()
        dest = settings.uploads_dir / f"{doc.id}{ALLOWED_TYPES[content_type]}"
        dest.write_bytes(content)
        doc.stored_path = str(dest)
        created.append(doc)

    db.commit()
    for doc in created:
        pipeline.enqueue(doc.id)
    return [_doc_out(d, []) for d in created]


@router.get("/{document_id}", response_model=DocumentDetail)
def get_document(document_id: str, db: Session = Depends(get_db)):
    doc = db.get(
        Document,
        document_id,
        options=[
            joinedload(Document.part_type),
            joinedload(Document.extractions).joinedload(Extraction.fields).joinedload(ExtractedField.corrections),
            joinedload(Document.extractions).joinedload(Extraction.prompt_version),
        ],
    )
    if doc is None:
        raise HTTPException(404, "Document not found")

    fields = _latest_fields(doc)
    extraction = doc.extractions[-1] if doc.extractions else None

    base = _doc_out(doc, fields)
    field_out = []
    for f in fields:
        item = ExtractedFieldOut.model_validate(f)
        if f.corrections:
            item.correction = f.corrections[-1]  # keep latest
        field_out.append(item)

    return DocumentDetail(
        **base.model_dump(),
        extraction_id=extraction.id if extraction else None,
        prompt_version_label=(
            extraction.prompt_version.label
            if extraction and extraction.prompt_version else None
        ),
        parse_quality_score=extraction.parse_quality_score if extraction else None,
        fields=field_out,
    )


@router.get("/{document_id}/file")
def get_document_file(document_id: str, db: Session = Depends(get_db)):
    doc = db.get(Document, document_id)
    if doc is None:
        raise HTTPException(404, "Document not found")
    path = pipeline.ensure_local_file(doc)
    if path is None:
        raise HTTPException(404, "File not found")
    return FileResponse(path, media_type=doc.content_type, filename=doc.filename)


@router.post("/{document_id}/process", response_model=DocumentOut)
def process_document(document_id: str, db: Session = Depends(get_db)):
    doc = db.get(Document, document_id)
    if doc is None:
        raise HTTPException(404, "Document not found")
    if doc.status == "processing":
        raise HTTPException(409, "Document is already processing")
    doc.status, doc.phase, doc.error = "queued", "queued", None
    db.commit()
    pipeline.enqueue(doc.id)
    return _doc_out(doc, _latest_fields(doc))


@router.post("/process-pending", response_model=list[DocumentOut])
def process_pending(db: Session = Depends(get_db)):
    docs = db.scalars(select(Document).where(Document.status.in_(["queued", "failed"]))).all()
    for doc in docs:
        doc.status, doc.phase, doc.error = "queued", "queued", None
    db.commit()
    for doc in docs:
        pipeline.enqueue(doc.id)
    return [_doc_out(d, _latest_fields(d)) for d in docs]


@router.delete("/{document_id}", status_code=204)
def delete_document(document_id: str, db: Session = Depends(get_db)):
    doc = db.get(Document, document_id)
    if doc is None:
        raise HTTPException(404, "Document not found")
    if doc.status == "processing":
        raise HTTPException(409, "Cannot delete a document while it is processing")
    artifacts = settings.artifacts_dir / doc.id
    # Correction.document_id isn't a real FK (it's kept even after fields/extractions are
    # gone, for history), so it doesn't cascade-delete on its own — clean it up explicitly
    db.execute(delete(Correction).where(Correction.document_id == document_id))
    db.delete(doc)
    db.commit()
    # remove the upload and any orientation-normalized sibling (<id>*.pdf)
    for f in settings.uploads_dir.glob(f"{doc.id}*"):
        f.unlink(missing_ok=True)
    if artifacts.exists():
        shutil.rmtree(artifacts, ignore_errors=True)
