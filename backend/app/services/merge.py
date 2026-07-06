"""Merge step: map Extract block citations onto precise page locations.

Sources, in order of precision:
1. Convert HTML word spans (<span data-bbox=...>) inside cited blocks — word-level
2. OCR text lines (the /ocr endpoint) — line-level with estimated word sub-spans;
   this is what locates values inside engineering drawings, which Convert treats
   as opaque Picture blocks with no word spans
3. The cited block's own bbox — block-level
4. Nothing ("none")

All coordinates are normalized to [0..1] of their own page so the two coordinate
spaces (Convert layout vs OCR image) compose safely.
"""

import json
import re
from dataclasses import dataclass, field
from difflib import SequenceMatcher

from bs4 import BeautifulSoup


@dataclass
class Word:
    text: str
    bbox: tuple[float, float, float, float]  # x0, y0, x1, y1 (source page coords)
    confidence: float | None
    page: int


@dataclass
class BlockInfo:
    id: str
    page: int
    bbox: tuple[float, float, float, float] | None
    words: list[Word] = field(default_factory=list)


@dataclass
class PageInfo:
    index: int
    width: float
    height: float


@dataclass
class OCRLine:
    text: str
    bbox: tuple[float, float, float, float]  # normalized [0..1]
    confidence: float | None
    page: int


@dataclass
class MergedBox:
    page: int | None
    x: float | None  # normalized
    y: float | None
    w: float | None
    h: float | None
    confidence: float | None
    match_quality: str  # word | line | block | none
    block_ids: list[str]


# ---------------------------------------------------------------------------
# Convert JSON parsing — pages, block -> page mapping, block bboxes
# ---------------------------------------------------------------------------

def _iter_blocks(node: dict, page_index: int | None = None):
    if not isinstance(node, dict):
        return
    block_type = node.get("block_type") or node.get("type")
    node_id = node.get("id") or ""
    if block_type == "Page" or re.search(r"/page/\d+/Page/", str(node_id)) or re.fullmatch(r"/page/\d+", str(node_id)):
        m = re.search(r"/page/(\d+)", str(node_id))
        page_index = int(m.group(1)) if m else (page_index if page_index is not None else 0)
        yield ("page", page_index, node)
    elif node_id:
        yield ("block", page_index, node)
    for child in node.get("children") or []:
        yield from _iter_blocks(child, page_index)


def _bbox_from_node(node: dict) -> tuple[float, float, float, float] | None:
    bbox = node.get("bbox")
    if isinstance(bbox, (list, tuple)) and len(bbox) == 4:
        return tuple(float(v) for v in bbox)
    poly = node.get("polygon")
    if isinstance(poly, (list, tuple)) and len(poly) >= 3:
        try:
            xs = [float(p[0]) for p in poly]
            ys = [float(p[1]) for p in poly]
            return (min(xs), min(ys), max(xs), max(ys))
        except (TypeError, ValueError, IndexError):
            return None
    return None


def parse_convert_json(convert_json) -> tuple[dict[int, PageInfo], dict[str, BlockInfo]]:
    """Extract page dimensions and block metadata from Convert's JSON output."""
    pages: dict[int, PageInfo] = {}
    blocks: dict[str, BlockInfo] = {}

    if isinstance(convert_json, str):
        try:
            convert_json = json.loads(convert_json, strict=False)
        except json.JSONDecodeError:
            return pages, blocks

    roots = convert_json if isinstance(convert_json, list) else [convert_json]
    for root in roots:
        if not isinstance(root, dict):
            continue
        for kind, page_index, node in _iter_blocks(root):
            bbox = _bbox_from_node(node)
            if kind == "page":
                idx = page_index if page_index is not None else len(pages)
                if bbox:
                    pages[idx] = PageInfo(idx, bbox[2] - bbox[0], bbox[3] - bbox[1])
                else:
                    pages.setdefault(idx, PageInfo(idx, 0, 0))
            else:
                node_id = str(node.get("id"))
                blocks[node_id] = BlockInfo(
                    id=node_id,
                    page=page_index if page_index is not None else 0,
                    bbox=bbox,
                )
    return pages, blocks


# ---------------------------------------------------------------------------
# Convert HTML parsing — word spans grouped by nearest block ancestor
# ---------------------------------------------------------------------------

def _page_of_block_id(block_id: str) -> int | None:
    m = re.search(r"/page/(\d+)", block_id)
    return int(m.group(1)) if m else None


def parse_convert_html(html: str, json_blocks: dict[str, BlockInfo]) -> dict[str, BlockInfo]:
    """Return block_id -> BlockInfo with word spans populated from the HTML."""
    soup = BeautifulSoup(html or "", "lxml")
    blocks: dict[str, BlockInfo] = {}

    for span in soup.find_all(attrs={"data-bbox": True}):
        raw = span.get("data-bbox", "")
        try:
            coords = tuple(float(v) for v in re.split(r"[,\s]+", raw.strip()) if v)
            if len(coords) != 4:
                continue
        except ValueError:
            continue
        text = span.get_text(" ", strip=True)
        if not text:
            continue
        conf_raw = span.get("data-confidence")
        try:
            conf = float(conf_raw) if conf_raw is not None else None
        except ValueError:
            conf = None

        ancestor = span if span.has_attr("data-block-id") else span.find_parent(attrs={"data-block-id": True})
        block_id = str(ancestor.get("data-block-id")) if ancestor else "__unassigned__"

        if block_id not in blocks:
            json_block = json_blocks.get(block_id)
            page = (
                json_block.page if json_block is not None
                else _page_of_block_id(block_id) or 0
            )
            blocks[block_id] = BlockInfo(
                id=block_id,
                page=page,
                bbox=json_block.bbox if json_block else None,
            )
        blocks[block_id].words.append(
            Word(text=text, bbox=coords, confidence=conf, page=blocks[block_id].page)
        )

    return blocks


# ---------------------------------------------------------------------------
# OCR parsing — text lines normalized to [0..1] page coordinates
# ---------------------------------------------------------------------------

def parse_ocr(ocr_payload) -> dict[int, list[OCRLine]]:
    """Return page_index (0-based) -> normalized OCR lines."""
    lines_by_page: dict[int, list[OCRLine]] = {}
    if not isinstance(ocr_payload, dict):
        return lines_by_page
    for i, page in enumerate(ocr_payload.get("pages") or []):
        if not isinstance(page, dict):
            continue
        page_no = page.get("page")
        page_index = (int(page_no) - 1) if isinstance(page_no, (int, float)) and page_no >= 1 else i
        image_bbox = page.get("image_bbox") or []
        try:
            pw = float(image_bbox[2]) - float(image_bbox[0])
            ph = float(image_bbox[3]) - float(image_bbox[1])
        except (TypeError, ValueError, IndexError):
            continue
        if pw <= 0 or ph <= 0:
            continue
        out: list[OCRLine] = []
        for line in page.get("text_lines") or []:
            text = (line.get("text") or "").strip()
            bbox = line.get("bbox") or _bbox_from_node(line)
            if not text or not bbox or len(bbox) != 4:
                continue
            try:
                x0, y0, x1, y1 = (float(v) for v in bbox)
            except (TypeError, ValueError):
                continue
            conf = line.get("confidence")
            out.append(OCRLine(
                text=text,
                bbox=(x0 / pw, y0 / ph, x1 / pw, y1 / ph),
                confidence=float(conf) if conf is not None else None,
                page=page_index,
            ))
        lines_by_page[page_index] = out
    return lines_by_page


# ---------------------------------------------------------------------------
# Fuzzy matching
# ---------------------------------------------------------------------------

_norm_re = re.compile(r"[^a-z0-9.]+")


def _normalize(text: str) -> str:
    return _norm_re.sub("", text.lower())


def _ratio(a: str, b: str) -> float:
    if not a or not b:
        return 0.0
    if a == b:
        return 1.0
    return SequenceMatcher(None, a, b).ratio()


def find_best_window(value: str, words: list[Word]) -> tuple[list[Word], float]:
    """Best consecutive run of words matching the value, with its score."""
    value_norm = _normalize(value)
    if not value_norm or not words:
        return [], 0.0

    # fuzzy ratios are meaningless for very short strings — "sc" scores 0.67
    # against a lone "S" and 0.57 against "SCALE" — so demand an exact match
    exact_only = len(value_norm) <= 3

    n_value_tokens = max(1, len(value.split()))
    best: list[Word] = []
    best_score = 0.0
    max_window = min(len(words), n_value_tokens + 4)

    for size in range(1, max_window + 1):
        for start in range(0, len(words) - size + 1):
            window = words[start:start + size]
            window_norm = "".join(_normalize(w.text) for w in window)
            if exact_only:
                score = 1.0 if window_norm == value_norm else 0.0
            else:
                score = _ratio(value_norm, window_norm)
            if score > best_score + 1e-9 or (abs(score - best_score) < 1e-9 and best and len(window) < len(best)):
                best, best_score = window, score
    return best, best_score


def _line_words(line: OCRLine) -> list[Word]:
    """Split an OCR line into words with x-ranges estimated by character position."""
    text = line.text
    total = max(len(text), 1)
    x0, y0, x1, y1 = line.bbox
    width = x1 - x0
    words: list[Word] = []
    for m in re.finditer(r"\S+", text):
        wx0 = x0 + (m.start() / total) * width
        wx1 = x0 + (m.end() / total) * width
        words.append(Word(text=m.group(0), bbox=(wx0, y0, wx1, y1), confidence=line.confidence, page=line.page))
    return words


def _match_ocr_lines(value: str, lines: list[OCRLine], threshold: float) -> tuple[list[Word], float]:
    """Best word window across OCR lines (each line searched independently)."""
    best: list[Word] = []
    best_score = 0.0
    for line in lines:
        words, score = find_best_window(value, _line_words(line))
        if score > best_score:
            best, best_score = words, score
    if best_score >= threshold:
        return best, best_score
    return [], best_score


# ---------------------------------------------------------------------------
# Geometry helpers
# ---------------------------------------------------------------------------

def _union_bbox(bboxes: list[tuple[float, float, float, float]]) -> tuple[float, float, float, float]:
    x0 = min(b[0] for b in bboxes)
    y0 = min(b[1] for b in bboxes)
    x1 = max(b[2] for b in bboxes)
    y1 = max(b[3] for b in bboxes)
    return (x0, y0, x1, y1)


def _normalize_bbox(bbox: tuple[float, float, float, float], page: PageInfo | None) -> tuple[float, float, float, float] | None:
    if page is None or not page.width or not page.height:
        return None
    x0, y0, x1, y1 = bbox
    return (
        max(0.0, min(1.0, x0 / page.width)),
        max(0.0, min(1.0, y0 / page.height)),
        max(0.0, min(1.0, (x1 - x0) / page.width)),
        max(0.0, min(1.0, (y1 - y0) / page.height)),
    )


def _norm_block_bbox(block: BlockInfo, pages: dict[int, PageInfo]) -> tuple[float, float, float, float] | None:
    if not block.bbox:
        return None
    norm = _normalize_bbox(block.bbox, pages.get(block.page))
    if not norm:
        return None
    return (norm[0], norm[1], norm[0] + norm[2], norm[1] + norm[3])  # x0,y0,x1,y1


def _intersects(a: tuple[float, float, float, float], b: tuple[float, float, float, float], pad: float = 0.01) -> bool:
    return not (a[2] + pad < b[0] or b[2] + pad < a[0] or a[3] + pad < b[1] or b[3] + pad < a[1])


def _resolve_block(cited: str, html_blocks: dict[str, BlockInfo], json_blocks: dict[str, BlockInfo]) -> BlockInfo | None:
    """Match a citation id against known blocks, tolerating format drift."""
    for source in (html_blocks, json_blocks):
        if cited in source:
            return source[cited]
    for source in (html_blocks, json_blocks):
        for bid, block in source.items():
            if bid.endswith(cited) or cited.endswith(bid):
                return block
    return None


def _avg_conf(words: list[Word]) -> float | None:
    confs = [w.confidence for w in words if w.confidence is not None]
    return sum(confs) / len(confs) if confs else None


# ---------------------------------------------------------------------------
# Field merge
# ---------------------------------------------------------------------------

WORD_THRESHOLD = 0.6
LINE_THRESHOLD = 0.6
GLOBAL_WORD_THRESHOLD = 0.82
GLOBAL_LINE_THRESHOLD = 0.85


def merge_field(
    value: str,
    citations: list[str],
    html_blocks: dict[str, BlockInfo],
    json_blocks: dict[str, BlockInfo],
    pages: dict[int, PageInfo],
    ocr_lines: dict[int, list[OCRLine]],
) -> MergedBox:
    resolved: list[BlockInfo] = []
    for cited in citations or []:
        block = _resolve_block(str(cited), html_blocks, json_blocks)
        if block is not None:
            if not block.words and block.id in html_blocks:
                block = html_blocks[block.id]
            resolved.append(block)
    block_ids = [b.id for b in resolved]

    def words_result(words: list[Word], quality: str, normalized: bool) -> MergedBox | None:
        if not words:
            return None
        page_idx = words[0].page
        bbox = _union_bbox([w.bbox for w in words])
        if normalized:
            norm = (bbox[0], bbox[1], bbox[2] - bbox[0], bbox[3] - bbox[1])
        else:
            norm = _normalize_bbox(bbox, pages.get(page_idx))
            if not norm:
                return None
        return MergedBox(
            page=page_idx, x=norm[0], y=norm[1], w=norm[2], h=norm[3],
            confidence=_avg_conf(words), match_quality=quality, block_ids=block_ids,
        )

    # ---- 1) word-level match inside cited blocks (convert HTML) ----------
    cited_words = [w for b in resolved for w in b.words]
    if cited_words:
        by_page: dict[int, list[Word]] = {}
        for w in cited_words:
            by_page.setdefault(w.page, []).append(w)
        best_words: list[Word] = []
        best_score = 0.0
        for page_words in by_page.values():
            words, score = find_best_window(value, page_words)
            if score > best_score:
                best_words, best_score = words, score
        if best_score >= WORD_THRESHOLD:
            result = words_result(best_words, "word", normalized=False)
            if result:
                return result

    # ---- 2) OCR lines restricted to the cited blocks' regions ------------
    cited_regions: list[tuple[int, tuple[float, float, float, float]]] = []
    for b in resolved:
        region = _norm_block_bbox(b, pages)
        if region:
            cited_regions.append((b.page, region))
    if cited_regions:
        candidates: list[OCRLine] = []
        for page_idx, region in cited_regions:
            for line in ocr_lines.get(page_idx, []):
                if _intersects(line.bbox, region):
                    candidates.append(line)
        words, score = _match_ocr_lines(value, candidates, LINE_THRESHOLD)
        if words:
            result = words_result(words, "line", normalized=True)
            if result:
                return result

    # ---- 3) document-wide word match (strict threshold) ------------------
    all_words = [w for b in html_blocks.values() for w in b.words]
    if all_words:
        by_page = {}
        for w in all_words:
            by_page.setdefault(w.page, []).append(w)
        best_words, best_score = [], 0.0
        for page_words in by_page.values():
            words, score = find_best_window(value, page_words)
            if score > best_score:
                best_words, best_score = words, score
        if best_score >= GLOBAL_WORD_THRESHOLD:
            result = words_result(best_words, "word", normalized=False)
            if result:
                return result

    # ---- 4) document-wide OCR line match (strict threshold) --------------
    all_lines = [l for lines in ocr_lines.values() for l in lines]
    words, score = _match_ocr_lines(value, all_lines, GLOBAL_LINE_THRESHOLD)
    if words:
        result = words_result(words, "line", normalized=True)
        if result:
            return result

    # ---- 5) cited block bbox fallback -------------------------------------
    for block in resolved:
        if block.bbox:
            norm = _normalize_bbox(block.bbox, pages.get(block.page))
            if norm:
                return MergedBox(
                    page=block.page,
                    x=norm[0], y=norm[1], w=norm[2], h=norm[3],
                    confidence=_avg_conf(block.words),
                    match_quality="block",
                    block_ids=block_ids,
                )

    return MergedBox(
        page=None, x=None, y=None, w=None, h=None,
        confidence=None, match_quality="none",
        block_ids=[str(c) for c in citations or []],
    )


def _xywh_overlap(a: dict, b: dict) -> bool:
    return not (
        a["x"] + a["w"] < b["x"] or b["x"] + b["w"] < a["x"]
        or a["y"] + a["h"] < b["y"] or b["y"] + b["h"] < a["y"]
    )


def _occurrence_boxes(
    value: str,
    source_text: str | None,
    citations: list[str],
    html_blocks: dict[str, BlockInfo],
    json_blocks: dict[str, BlockInfo],
    pages: dict[int, PageInfo],
) -> list[dict]:
    """One box per cited block — every place the extractor saw the value.

    Tries a tight word-level match inside each block (source text first, since
    that's what is physically printed), falling back to the block region.
    """
    occs: list[dict] = []
    seen: set[str] = set()
    for cited in citations:
        block = _resolve_block(str(cited), html_blocks, json_blocks)
        if block is None or block.id in seen:
            continue
        seen.add(block.id)
        if not block.words and block.id in html_blocks:
            block = html_blocks[block.id]

        best_words: list[Word] = []
        best_score = 0.0
        for needle in (source_text, value):
            if not needle:
                continue
            words, score = find_best_window(needle, block.words)
            if score > best_score:
                best_words, best_score = words, score
        if best_score >= WORD_THRESHOLD and best_words:
            bbox = _union_bbox([w.bbox for w in best_words])
            norm = _normalize_bbox(bbox, pages.get(best_words[0].page))
            if norm:
                occs.append({"page": best_words[0].page, "x": norm[0], "y": norm[1], "w": norm[2], "h": norm[3], "q": "word"})
                continue

        region = _norm_block_bbox(block, pages)
        if region is not None and block.page is not None:
            occs.append({
                "page": block.page,
                "x": region[0], "y": region[1],
                "w": region[2] - region[0], "h": region[3] - region[1],
                "q": "block",
            })
    return occs


# ---------------------------------------------------------------------------
# Extraction payload parsing
# ---------------------------------------------------------------------------

def parse_extraction_values(extract_payload: dict) -> dict:
    raw = extract_payload.get("extraction_schema_json")
    if raw is None:
        raw = extract_payload.get("json")
    if isinstance(raw, str):
        try:
            raw = json.loads(raw, strict=False)
        except json.JSONDecodeError:
            return {}
    return raw if isinstance(raw, dict) else {}


# Datalab's balanced-mode verifier appends boilerplate to reasoning/feedback:
# an agreeing "Conclusion: <value>, which agrees with the extraction." and/or a
# trailing "PASS:\nConclusion: …" block. A passing conclusion only restates the
# value, so both are stripped; FAIL/WARN conclusions carry signal and are kept.
_AGREE_CONCLUSION = re.compile(
    r"\s*Conclusion:.*?which agrees with the extraction\.?\s*$",
    re.IGNORECASE | re.DOTALL,
)
# the agree-wording for empty fields
_NULL_CONCLUSION = re.compile(
    r"\s*Conclusion:\s*the document does not support a value for this field\.?\s*$",
    re.IGNORECASE,
)
_PASS_TRAILER = re.compile(r"\s*\bPASS:?\s*(?:Conclusion:.*)?$", re.DOTALL)


def _clean_verifier_text(text: str) -> str:
    """Strip Datalab verifier boilerplate from reasoning/feedback strings."""
    text = _AGREE_CONCLUSION.sub("", text)
    text = _NULL_CONCLUSION.sub("", text)
    text = _PASS_TRAILER.sub("", text)
    return text.strip()


def _field_meta(values: dict, key: str) -> str | None:
    """Surface balanced-mode reasoning/verification for the UI."""
    meta = values.get(f"{key}_meta")
    if not isinstance(meta, dict):
        return None
    parts = []
    reasoning = meta.get("reasoning")
    if isinstance(reasoning, str):
        reasoning = _clean_verifier_text(reasoning)
        if reasoning:
            parts.append(reasoning)
    status = meta.get("extraction_status")
    verification = meta.get("verification")
    v_status = verification.get("status") if isinstance(verification, dict) else None
    if status and status != "EXTRACTED":
        parts.append(f"Datalab extraction status: {status} — this value has no source citation; verify it carefully.")
    elif v_status and v_status != "PASS":
        parts.append(f"Datalab verification: {v_status} — verify this value carefully.")
    feedback = verification.get("feedback") if isinstance(verification, dict) else None
    if isinstance(feedback, str):
        feedback = _clean_verifier_text(feedback)
        if feedback:
            parts.append(feedback)
    return " ".join(parts) if parts else None


def merge_extraction(
    extract_payload: dict,
    convert_html: str,
    convert_json,
    field_keys: list[str],
    ocr_payload=None,
) -> dict[str, dict]:
    """Produce {field_key: {value, page, bbox, confidence, match_quality, block_ids, reasoning}}."""
    pages, json_blocks = parse_convert_json(convert_json)
    html_blocks = parse_convert_html(convert_html, json_blocks)
    ocr_lines = parse_ocr(ocr_payload)
    values = parse_extraction_values(extract_payload)

    results: dict[str, dict] = {}
    for key in field_keys:
        value = values.get(key)
        citations = values.get(f"{key}_citations") or []
        if not isinstance(citations, list):
            citations = [citations]
        citations = [str(c) for c in citations]

        source_raw = values.get(f"{key}_source")
        source_text = source_raw.strip() if isinstance(source_raw, str) and source_raw.strip() else None
        source_citations = values.get(f"{key}_source_citations") or []
        if not isinstance(source_citations, list):
            source_citations = [source_citations]
        source_citations = [str(c) for c in source_citations] or citations

        if value is None or (isinstance(value, str) and not value.strip()):
            results[key] = {
                "value": None, "source_text": source_text, "page": None, "bbox": None,
                "confidence": None, "match_quality": "none", "block_ids": [],
                "locations": [], "reasoning": _field_meta(values, key),
            }
            continue

        value_str = str(value)

        # Locate by the verbatim printed source text first — for normalized or
        # inferred values (e.g. "Cone Washer" derived from "CONE.WASH") only the
        # source text physically exists on the page. Fall back to the value.
        box = None
        source_box = None
        if source_text and _normalize(source_text) != _normalize(value_str):
            source_box = merge_field(source_text, source_citations, html_blocks, json_blocks, pages, ocr_lines)
            if source_box.match_quality in ("word", "line"):
                box = source_box
        if box is None:
            value_box = merge_field(value_str, citations, html_blocks, json_blocks, pages, ocr_lines)
            if value_box.match_quality != "none":
                box = value_box
            elif source_box is not None and source_box.match_quality != "none":
                box = source_box
            else:
                box = value_box

        # every occurrence of the value on the document, primary location first
        locations: list[dict] = []
        if box.x is not None:
            primary = {"page": box.page, "x": box.x, "y": box.y, "w": box.w, "h": box.h, "q": box.match_quality}
            locations.append(primary)
            all_citations = citations + [c for c in source_citations if c not in citations]
            for occ in _occurrence_boxes(value_str, source_text, all_citations, html_blocks, json_blocks, pages):
                duplicate = any(
                    occ["page"] == known["page"] and _xywh_overlap(occ, known) for known in locations
                )
                if not duplicate:
                    locations.append(occ)

        results[key] = {
            "value": value_str,
            "source_text": source_text,
            "page": box.page,
            "bbox": None if box.x is None else {"x": box.x, "y": box.y, "w": box.w, "h": box.h},
            "confidence": box.confidence,
            "match_quality": box.match_quality,
            "block_ids": box.block_ids,
            "locations": locations,
            "reasoning": _field_meta(values, key),
        }
    return results
