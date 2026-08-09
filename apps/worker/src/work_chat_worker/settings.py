from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=".env", extra="ignore")

    nats_url: str = "nats://localhost:4222"
    database_url: str | None = None
    opensearch_url: str | None = None
    opensearch_username: str | None = None
    opensearch_password: str | None = None
    worker_consumer: str = "work-chat-indexer-v1"

