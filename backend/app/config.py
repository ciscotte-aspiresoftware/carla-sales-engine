from pydantic_settings import BaseSettings
from pathlib import Path
from typing import Optional


class Settings(BaseSettings):
    anthropic_api_key: str = ""
    tavily_api_key: Optional[str] = None
    apollo_api_key: Optional[str] = None
    firecrawl_api_key: Optional[str] = None
    database_url: str = "sqlite:///./aspire_demo.db"
    packs_dir: str = "./packs"
    environment: str = "development"
    allowed_origins: str = "http://localhost:3000,http://127.0.0.1:3000"

    model_config = {"env_file": ".env", "env_file_encoding": "utf-8"}

    @property
    def packs_path(self) -> Path:
        return Path(self.packs_dir)


settings = Settings()
