from datetime import datetime

from pydantic import BaseModel, ConfigDict, Field


class ORMModel(BaseModel):
    model_config = ConfigDict(from_attributes=True)


# ---- Bounding boxes -------------------------------------------------------

class BBox(BaseModel):
    x: float
    y: float
    w: float
    h: float
    page: int | None = None


# ---- Part types & fields --------------------------------------------------

class FieldDefinitionIn(BaseModel):
    id: int | None = None
    key: str
    label: str
    description: str = ""
    example: str = ""
    active: bool = True


class FieldDefinitionOut(ORMModel):
    id: int
    key: str
    label: str
    description: str
    example: str
    sort_order: int
    active: bool


class PartTypeIn(BaseModel):
    name: str
    description: str = ""


class PartTypeOut(ORMModel):
    id: int
    name: str
    description: str
    created_at: datetime
    fields: list[FieldDefinitionOut] = []


# ---- Standards ------------------------------------------------------------

class StandardRuleIn(BaseModel):
    title: str
    rule: str
    context: str = ""
    active: bool = True


class StandardRulePatch(BaseModel):
    title: str | None = None
    rule: str | None = None
    context: str | None = None
    active: bool | None = None


class StandardRuleOut(ORMModel):
    id: int
    title: str
    rule: str
    context: str
    active: bool
    sort_order: int
    updated_at: datetime


# ---- Corrections ----------------------------------------------------------

class CorrectionIn(BaseModel):
    field_id: int
    corrected_value: str
    reason: str = ""
    category: str = ""
    bbox: BBox | None = None


class SnippetPreviewIn(BaseModel):
    field_id: int
    bbox: BBox


class SnippetPreviewOut(BaseModel):
    source_snippet: str | None = None


class CorrectionOut(ORMModel):
    id: int
    field_id: int | None
    document_id: str
    document_name: str
    field_key: str
    field_label: str
    original_value: str | None
    corrected_value: str
    reason: str
    category: str
    source_snippet: str | None = None
    page: int | None
    bbox_x: float | None
    bbox_y: float | None
    bbox_w: float | None
    bbox_h: float | None
    created_at: datetime


# ---- Extracted fields -----------------------------------------------------

class FieldLocation(BaseModel):
    page: int
    x: float
    y: float
    w: float
    h: float
    q: str = "block"


class ExtractedFieldOut(ORMModel):
    id: int
    field_key: str
    label: str
    value: str | None
    confidence: float | None
    page: int | None
    bbox_x: float | None
    bbox_y: float | None
    bbox_w: float | None
    bbox_h: float | None
    locations: list[FieldLocation] = []
    match_quality: str
    source_text: str | None
    ai_reasoning: str | None
    status: str
    corrected_value: str | None
    sort_order: int
    correction: CorrectionOut | None = None


class FieldStatusPatch(BaseModel):
    status: str = Field(pattern="^(unverified|verified)$")


# ---- Documents ------------------------------------------------------------

class DocumentOut(ORMModel):
    id: str
    filename: str
    status: str
    phase: str
    error: str | None
    page_count: int | None
    part_number: str | None
    part_type_id: int | None
    part_type_name: str | None = None
    created_at: datetime
    processed_at: datetime | None
    fields_total: int = 0
    fields_verified: int = 0
    fields_corrected: int = 0
    avg_confidence: float | None = None


class DocumentDetail(DocumentOut):
    extraction_id: int | None = None
    prompt_version_label: str | None = None
    parse_quality_score: float | None = None
    fields: list[ExtractedFieldOut] = []


# ---- Prompt versions ------------------------------------------------------

class PromptVersionIn(BaseModel):
    label: str = ""
    notes: str = ""


class PromptVersionOut(ORMModel):
    id: int
    version_number: int
    label: str
    notes: str
    created_at: datetime
    documents_processed: int = 0
    fields_reviewed: int = 0
    accuracy: float | None = None


class PromptPreview(BaseModel):
    part_type_id: int
    part_type_name: str
    prompt_text: str
    page_schema: dict


# ---- Dashboard ------------------------------------------------------------

class ErrorPattern(BaseModel):
    field_key: str
    field_label: str
    count: int
    last_reason: str
    categories: list[str] = []


class VersionAccuracy(BaseModel):
    id: int
    label: str
    created_at: datetime
    fields_reviewed: int
    accuracy: float | None


class DashboardStats(BaseModel):
    documents_total: int
    documents_completed: int
    documents_failed: int
    fields_total: int
    fields_verified: int
    fields_corrected: int
    fields_unverified: int
    corrections_total: int
    overall_accuracy: float | None
    avg_confidence: float | None


class DashboardOut(BaseModel):
    stats: DashboardStats
    error_patterns: list[ErrorPattern]
    version_accuracy: list[VersionAccuracy]
    recent_corrections: list[CorrectionOut]


class MetaOut(BaseModel):
    mode: str
    extraction_mode: str
    has_api_key: bool
