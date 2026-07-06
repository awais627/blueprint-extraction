import uuid
from datetime import datetime, timezone

from sqlalchemy import JSON, Boolean, DateTime, Float, ForeignKey, Integer, LargeBinary, String, Text
from sqlalchemy.orm import Mapped, mapped_column, relationship

from .database import Base


def utcnow() -> datetime:
    return datetime.now(timezone.utc)


def new_id() -> str:
    return uuid.uuid4().hex


class PartType(Base):
    __tablename__ = "part_types"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    name: Mapped[str] = mapped_column(String(100), unique=True)
    description: Mapped[str] = mapped_column(Text, default="")
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)

    fields: Mapped[list["FieldDefinition"]] = relationship(
        back_populates="part_type", cascade="all, delete-orphan", order_by="FieldDefinition.sort_order"
    )


class FieldDefinition(Base):
    __tablename__ = "field_definitions"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    part_type_id: Mapped[int] = mapped_column(ForeignKey("part_types.id", ondelete="CASCADE"))
    key: Mapped[str] = mapped_column(String(100))
    label: Mapped[str] = mapped_column(String(200))
    description: Mapped[str] = mapped_column(Text, default="")
    example: Mapped[str] = mapped_column(String(300), default="")
    sort_order: Mapped[int] = mapped_column(Integer, default=0)
    active: Mapped[bool] = mapped_column(Boolean, default=True)

    part_type: Mapped[PartType] = relationship(back_populates="fields")


class StandardRule(Base):
    __tablename__ = "standard_rules"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    title: Mapped[str] = mapped_column(String(200))
    rule: Mapped[str] = mapped_column(Text)
    context: Mapped[str] = mapped_column(Text, default="")
    active: Mapped[bool] = mapped_column(Boolean, default=True)
    sort_order: Mapped[int] = mapped_column(Integer, default=0)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow, onupdate=utcnow)


class PromptVersion(Base):
    __tablename__ = "prompt_versions"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    version_number: Mapped[int] = mapped_column(Integer)
    label: Mapped[str] = mapped_column(String(50))
    notes: Mapped[str] = mapped_column(Text, default="")
    # snapshot of the assembled prompt/schema per part type at publish time
    snapshot: Mapped[dict] = mapped_column(JSON, default=dict)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)


class Document(Base):
    __tablename__ = "documents"

    id: Mapped[str] = mapped_column(String(32), primary_key=True, default=new_id)
    filename: Mapped[str] = mapped_column(String(300))
    stored_path: Mapped[str] = mapped_column(String(500))
    # canonical copy of whatever stored_path currently points to — the local
    # disk file is ephemeral on redeploy, this is the durable backing store
    file_data: Mapped[bytes | None] = mapped_column(LargeBinary, nullable=True)
    content_type: Mapped[str] = mapped_column(String(100), default="application/pdf")
    part_type_id: Mapped[int | None] = mapped_column(ForeignKey("part_types.id", ondelete="SET NULL"), nullable=True)
    # queued | processing | completed | failed
    status: Mapped[str] = mapped_column(String(20), default="queued")
    # queued | convert | extract | merge | done
    phase: Mapped[str] = mapped_column(String(20), default="queued")
    error: Mapped[str | None] = mapped_column(Text, nullable=True)
    page_count: Mapped[int | None] = mapped_column(Integer, nullable=True)
    checkpoint_id: Mapped[str | None] = mapped_column(String(100), nullable=True)
    part_number: Mapped[str | None] = mapped_column(String(100), nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)
    processed_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)

    part_type: Mapped[PartType | None] = relationship()
    extractions: Mapped[list["Extraction"]] = relationship(
        back_populates="document", cascade="all, delete-orphan", order_by="Extraction.created_at"
    )


class Extraction(Base):
    __tablename__ = "extractions"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    document_id: Mapped[str] = mapped_column(ForeignKey("documents.id", ondelete="CASCADE"))
    prompt_version_id: Mapped[int | None] = mapped_column(ForeignKey("prompt_versions.id", ondelete="SET NULL"))
    extraction_mode: Mapped[str] = mapped_column(String(20), default="balanced")
    page_count: Mapped[int | None] = mapped_column(Integer, nullable=True)
    parse_quality_score: Mapped[float | None] = mapped_column(Float, nullable=True)
    artifacts_dir: Mapped[str] = mapped_column(String(500), default="")
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)

    document: Mapped[Document] = relationship(back_populates="extractions")
    prompt_version: Mapped[PromptVersion | None] = relationship()
    fields: Mapped[list["ExtractedField"]] = relationship(
        back_populates="extraction", cascade="all, delete-orphan", order_by="ExtractedField.sort_order"
    )


class ExtractedField(Base):
    __tablename__ = "extracted_fields"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    extraction_id: Mapped[int] = mapped_column(ForeignKey("extractions.id", ondelete="CASCADE"))
    document_id: Mapped[str] = mapped_column(String(32), index=True)
    field_key: Mapped[str] = mapped_column(String(100))
    label: Mapped[str] = mapped_column(String(200))
    value: Mapped[str | None] = mapped_column(Text, nullable=True)
    confidence: Mapped[float | None] = mapped_column(Float, nullable=True)
    page: Mapped[int | None] = mapped_column(Integer, nullable=True)
    # normalized [0..1] page coordinates
    bbox_x: Mapped[float | None] = mapped_column(Float, nullable=True)
    bbox_y: Mapped[float | None] = mapped_column(Float, nullable=True)
    bbox_w: Mapped[float | None] = mapped_column(Float, nullable=True)
    bbox_h: Mapped[float | None] = mapped_column(Float, nullable=True)
    # every occurrence of the value on the document, primary first: [{page,x,y,w,h,q}]
    locations: Mapped[list] = mapped_column(JSON, default=list)
    block_ids: Mapped[list] = mapped_column(JSON, default=list)
    # word | line | block | none — how precisely the bbox was matched
    match_quality: Mapped[str] = mapped_column(String(10), default="none")
    # verbatim printed text the value was derived from (e.g. "CONE.WASH" -> "Cone Washer")
    source_text: Mapped[str | None] = mapped_column(Text, nullable=True)
    ai_reasoning: Mapped[str | None] = mapped_column(Text, nullable=True)
    # unverified | verified | corrected
    status: Mapped[str] = mapped_column(String(20), default="unverified")
    corrected_value: Mapped[str | None] = mapped_column(Text, nullable=True)
    sort_order: Mapped[int] = mapped_column(Integer, default=0)

    extraction: Mapped[Extraction] = relationship(back_populates="fields")
    corrections: Mapped[list["Correction"]] = relationship(order_by="Correction.created_at")


class Correction(Base):
    __tablename__ = "corrections"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    field_id: Mapped[int | None] = mapped_column(ForeignKey("extracted_fields.id", ondelete="SET NULL"), nullable=True)
    document_id: Mapped[str] = mapped_column(String(32), index=True)
    document_name: Mapped[str] = mapped_column(String(300), default="")
    field_key: Mapped[str] = mapped_column(String(100))
    field_label: Mapped[str] = mapped_column(String(200), default="")
    original_value: Mapped[str | None] = mapped_column(Text, nullable=True)
    corrected_value: Mapped[str] = mapped_column(Text)
    reason: Mapped[str] = mapped_column(Text, default="")
    category: Mapped[str] = mapped_column(String(100), default="")
    # OCR text found under the engineer's marked box — verbatim printed evidence
    source_snippet: Mapped[str | None] = mapped_column(Text, nullable=True)
    page: Mapped[int | None] = mapped_column(Integer, nullable=True)
    bbox_x: Mapped[float | None] = mapped_column(Float, nullable=True)
    bbox_y: Mapped[float | None] = mapped_column(Float, nullable=True)
    bbox_w: Mapped[float | None] = mapped_column(Float, nullable=True)
    bbox_h: Mapped[float | None] = mapped_column(Float, nullable=True)
    prompt_version_id: Mapped[int | None] = mapped_column(ForeignKey("prompt_versions.id", ondelete="SET NULL"), nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)
