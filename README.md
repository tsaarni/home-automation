# homeautomation

Monorepo for home automation services, frontend, and cluster infrastructure.

## Repository layout

```
homeautomation/
├── automator/    # Home automator service (Python / FastAPI)
├── infra/        # Kubernetes manifests and container build tooling
│   ├── docker/   # Dockerfiles and Kubernetes build instructions
│   └── manifests/# Workload manifests for k3s
├── metrics/      # Metrics scraper pushing to VictoriaMetrics (Python)
└── webui/        # Web UI for home automation (React / Vite / TypeScript)
```

## Microservice Container Builds

Custom service images are built on the Kubernetes node `mele` with Docker Buildx
and pushed to Quay. See [the build instructions](infra/docker/README.md).

## Developing and Testing

### Automator (`automator/`)
```bash
cd automator
uv sync
uv run pytest -q
```

### Metrics (`metrics/`)
```bash
cd metrics
uv sync
uv run python -m homemetrics --config config.yaml
```

### Web UI (`webui/`)
```bash
cd webui
pnpm install
pnpm test
pnpm build
pnpm dev
```

[Device gateway](device-gateway/README.md) connects opt-in automator devices to
Shelly RPC and MELCloud, with independent reported state and correlated command results.
