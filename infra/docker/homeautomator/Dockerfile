# syntax=docker/dockerfile:1
FROM python:3.14-alpine3.23 AS base
RUN apk add --no-cache tzdata \
 && addgroup -g 10001 app \
 && adduser -D -H -u 10001 -G app app
ENV PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1 \
    PATH="/app/.venv/bin:$PATH"
WORKDIR /app

FROM base AS build
COPY --from=ghcr.io/astral-sh/uv:0.13.0 /uv /usr/local/bin/uv
ENV UV_LINK_MODE=copy UV_PYTHON_DOWNLOADS=never
COPY pyproject.toml uv.lock README.md ./
RUN --mount=type=cache,target=/root/.cache/uv \
    uv sync --locked --no-dev --no-install-project
COPY src ./src
RUN --mount=type=cache,target=/root/.cache/uv \
    uv sync --locked --no-dev --no-editable

FROM base AS runtime
COPY --from=build /app/.venv /app/.venv
COPY seed /opt/seed
RUN mkdir /data && chown app:app /data
USER 10001:10001
ENV DATA_DIR=/data \
    HOST=0.0.0.0 \
    PORT=80 \
    TZ=Europe/Helsinki \
    LAT=60.4518 \
    LON=22.2666
EXPOSE 80
ENTRYPOINT ["automator"]
