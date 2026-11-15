# syntax=docker/dockerfile:1
FROM python:3.12-slim@sha256:5e2bdb1b0d542d5039cffb8181c65930093949194a65c365dfb1b0fe13a4fa5b AS base
ENV UV_COMPILE_BYTECODE=1 UV_LINK_MODE=copy UV_PROJECT_ENVIRONMENT=/opt/venv \
    PYTHONUNBUFFERED=1 PYTHONDONTWRITEBYTECODE=1 PATH="/opt/venv/bin:$PATH"
RUN pip install --no-cache-dir uv==0.13.7
WORKDIR /app
COPY pyproject.toml uv.lock .python-version ./

FROM base AS dev
RUN uv sync --frozen --no-install-project
COPY src ./src
RUN uv sync --frozen

FROM base AS build
RUN uv sync --frozen --no-install-project --no-dev
COPY src ./src
RUN uv sync --frozen --no-dev --no-editable

FROM python:3.12-slim@sha256:5e2bdb1b0d542d5039cffb8181c65930093949194a65c365dfb1b0fe13a4fa5b AS runtime
ENV PATH="/opt/venv/bin:$PATH" PYTHONUNBUFFERED=1 DESTELLO_DATA_DIR=/data
RUN useradd --system --uid 10001 --home-dir /nonexistent --shell /usr/sbin/nologin destello \
    && mkdir -p /data && chown destello:destello /data
COPY --from=build /opt/venv /opt/venv
USER destello
WORKDIR /app
EXPOSE 8000
CMD ["uvicorn", "destello.api.main:app", "--host", "0.0.0.0", "--port", "8000"]
