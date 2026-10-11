# Build and push: see ../README.md (commands run from the repository root)
# Manual: podman build -f docker/homemetrics/Dockerfile -t quay.io/tsaarni/home-metrics:latest ~/hobby/home-metrics
FROM python:3.14-slim

LABEL org.opencontainers.image.title="home-metrics" \
      org.opencontainers.image.description="Metrics scraper pushing to VictoriaMetrics" \
      org.opencontainers.image.source="https://github.com/tsaarni/home-metrics"

ENV PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1 \
    PIP_NO_CACHE_DIR=1 \
    PIP_DISABLE_PIP_VERSION_CHECK=1

RUN apt-get update \
 && apt-get install --no-install-recommends -y tzdata ca-certificates \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY pyproject.toml README.md ./
COPY src ./src
COPY logging.yaml ./
RUN pip install .

RUN useradd --create-home --uid 10001 metrics \
 && python -c "from homemetrics import __version__; print('homemetrics', __version__)"
USER metrics

ENTRYPOINT ["python", "-m", "homemetrics"]
CMD ["--config", "/config/config.yaml"]
