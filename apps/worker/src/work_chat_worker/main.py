from contextlib import asynccontextmanager

from fastapi import FastAPI

from .consumer import EventConsumer
from .settings import Settings

settings = Settings()
consumer = EventConsumer(settings)


@asynccontextmanager
async def lifespan(_: FastAPI):
    await consumer.start()
    yield
    await consumer.close()


app = FastAPI(title="Work Chat Worker", lifespan=lifespan)


@app.get("/health/live")
async def live() -> dict[str, str]:
    return {"status": "ok"}


@app.get("/health/ready")
async def ready() -> dict[str, str]:
    return {"status": "ready"}

