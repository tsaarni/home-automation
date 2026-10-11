# Build and push: see ../README.md (commands run from the repository root)
# Manual: podman build -f docker/homeautomator/Dockerfile -t quay.io/tsaarni/home-automator:latest ~/hobby/home-automator
#
# The image holds the installed package plus the seed documents and the extraction tool in
# /opt/seed (see seed/README.md). The service keeps its data in DATA_DIR, which is a volume.
FROM python:3.14-slim

LABEL org.opencontainers.image.title="home-automator" \
      org.opencontainers.image.description="Home automation as data: devices, groups and rules as JSON documents" \
      org.opencontainers.image.source="https://github.com/tsaarni/home-automator"

ENV PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1 \
    PIP_NO_CACHE_DIR=1 \
    PIP_DISABLE_PIP_VERSION_CHECK=1

# tzdata: the schedules use zoneinfo, and the slim image does not ship the zone database
RUN apt-get update \
 && apt-get install --no-install-recommends -y tzdata ca-certificates \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY pyproject.toml README.md ./
COPY src ./src
RUN pip install .

# seed documents, the installer and the extraction tool (not used by the running service)
COPY seed /opt/seed

RUN useradd --create-home --uid 10001 automator \
 && mkdir -p /data \
 && chown automator:automator /data \
 && python -c "from zoneinfo import ZoneInfo; ZoneInfo('Europe/Helsinki')" \
 && python -c "from automator import __version__; print('automator', __version__)"
USER automator

# defaults; the deployment sets the real values
ENV DATA_DIR=/data \
    HOST=0.0.0.0 \
    PORT=80 \
    TZ=Europe/Helsinki \
    LAT=60.4518 \
    LON=22.2666

EXPOSE 80
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s \
  CMD python -c "import urllib.request; urllib.request.urlopen('http://127.0.0.1:80/healthz').read()"

ENTRYPOINT ["python", "-m", "automator"]
