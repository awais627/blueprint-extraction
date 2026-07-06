import logging

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from .config import settings
from .database import Base, SessionLocal, engine
from .routers import config as config_router
from .routers import dashboard, documents, fields, prompts
from .seed import seed
from .services.pipeline import start_workers

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(name)s %(levelname)s %(message)s")
logger = logging.getLogger(__name__)

# docs live under /api/ so the nginx frontend can proxy them (:8080/api/docs)
app = FastAPI(
    title="Blueprint Extraction Platform",
    version="1.0.0",
    docs_url="/api/docs",
    redoc_url="/api/redoc",
    openapi_url="/api/openapi.json",
)

app.add_middleware(
    CORSMiddleware,
    allow_origin_regex=r"http://(localhost|127\.0\.0\.1)(:\d+)?|https://blueprint-asf\.hubextech\.com",
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

app.include_router(documents.router)
app.include_router(fields.router)
app.include_router(config_router.router)
app.include_router(prompts.router)
app.include_router(dashboard.router)


@app.get("/api/health")
def health():
    return {"status": "ok", "mode": settings.resolved_mode}


def _run_migrations():
    """Additive column migrations for existing databases (create_all
    only creates missing tables, never missing columns)."""
    from sqlalchemy import text

    migrations = [
        "ALTER TABLE extracted_fields ADD COLUMN source_text TEXT",
        "ALTER TABLE corrections ADD COLUMN source_snippet TEXT",
    ]
    for stmt in migrations:
        try:
            with engine.begin() as conn:
                conn.execute(text(stmt))
            logger.info("Applied migration: %s", stmt)
        except Exception:
            pass  # column already exists


@app.on_event("startup")
def on_startup():
    settings.data_dir.mkdir(parents=True, exist_ok=True)
    settings.uploads_dir.mkdir(parents=True, exist_ok=True)
    settings.artifacts_dir.mkdir(parents=True, exist_ok=True)
    Base.metadata.create_all(engine)
    _run_migrations()
    db = SessionLocal()
    try:
        seed(db)
    finally:
        db.close()
    start_workers()
    logger.info("Blueprint Extraction Platform ready (datalab mode: %s)", settings.resolved_mode)
