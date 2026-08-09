FROM python:3.13-slim
WORKDIR /app
COPY apps/worker/pyproject.toml ./
COPY apps/worker/src ./src
RUN pip install --no-cache-dir .
EXPOSE 8000
CMD ["uvicorn", "work_chat_worker.main:app", "--host", "0.0.0.0", "--port", "8000"]

