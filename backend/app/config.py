from pathlib import Path

from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=".env", extra="ignore")

    datalab_api_key: str = ""
    datalab_base_url: str = "https://www.datalab.to/api/v1"
    # auto -> real when an API key is present, mock otherwise
    datalab_mode: str = "auto"
    # turbo | fast | balanced — balanced returns verification metadata
    extraction_mode: str = "balanced"

    data_dir: Path = Path("data-store")
    database_url: str = "postgresql+psycopg://blueprint:blueprint@localhost:5433/blueprint_local"
    poll_interval: float = 2.0
    poll_timeout: float = 900.0
    pipeline_workers: int = 2

    @property
    def resolved_mode(self) -> str:
        if self.datalab_mode == "auto":
            return "real" if self.datalab_api_key else "mock"
        return self.datalab_mode

    @property
    def uploads_dir(self) -> Path:
        return self.data_dir / "uploads"

    @property
    def artifacts_dir(self) -> Path:
        return self.data_dir / "artifacts"


settings = Settings()
