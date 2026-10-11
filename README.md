# homeautomation

Monorepo for home automation services, frontend, and cluster infrastructure.

## Repository layout

```
homeautomation/
├── automator/    # Home automator service (Python / FastAPI)
├── infra/        # Kubernetes manifests and container build tooling
│   ├── docker/   # Cluster-delegated container builds (build.sh)
│   └── manifests/# Workload manifests for k3s
├── metrics/      # Metrics scraper pushing to VictoriaMetrics (Python)
└── webui/        # Web UI for home automation (React / Vite / TypeScript)
```

## Microservice Container Builds

All container builds for custom microservices are centrally managed under `infra/docker/` using `build.sh`.
The script packs the build context, delegates `podman build` to a temporary privileged pod running on the cluster node (`mele`), imports the resulting image directly into the node's k3s containerd store, and restarts the associated Kubernetes Deployment.

```bash
# List available images and settings
infra/docker/build.sh --list

# Build, load into containerd, and restart deployment
infra/docker/build.sh homeautomator
infra/docker/build.sh homemetrics

# Build and load only (no restart)
infra/docker/build.sh homeautomator --no-restart

# Dry run (print resolved build context and parameters)
infra/docker/build.sh homeautomator --dry-run
```

Image configurations live in `infra/docker/<name>/`:
- `infra/docker/homeautomator/`: `Dockerfile` and `image.conf` for `homeautomator` (`quay.io/tsaarni/home-automator:latest`)
- `infra/docker/homemetrics/`: `Dockerfile` and `image.conf` for `homemetrics` (`quay.io/tsaarni/home-metrics:latest`)

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
uv sync # or pip install -r requirements.txt
python3 src/main.py --config config.yaml
```

### Web UI (`webui/`)
```bash
cd webui
pnpm install
pnpm test
pnpm build
pnpm dev
```
