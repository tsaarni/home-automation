# Container builds

Run from the repository root. All images use `latest`.

The three Python images use Python 3.14 on Alpine 3.23, with production dependencies
installed from `uv.lock`. A separate build stage keeps uv, source files and build
caches out of the runtime. Each service runs as UID/GID 10001. Alpine works with
the locked amd64 musl wheels; keep wheel compatibility in mind when updating
dependencies. Build contexts exclude local configuration, data and virtualenvs.

## Web UI

The web UI uses Node.js 24 and pnpm to build the locked dependencies, then copies
only `dist/` into `nginx:stable-alpine-slim`. The runtime runs as UID/GID 10001 on
port 8080, serves SPA routes, and proxies `/api/*`, `/readyz` and `/metrics` to
`API_TARGET` (default `http://homeautomator:80`). Set `API_TARGET` at runtime to
an upstream origin without a trailing slash or path. `/healthz` checks the static
server independently of the backend. Mocks are disabled and the API base is
same-origin in the production build.

```bash
docker build -f infra/docker/webui/Dockerfile -t home-webui:latest webui
docker run --rm -p 8080:8080 --network homeautomation \
  -e API_TARGET=http://homeautomator:80 home-webui:latest
```

The run example assumes an existing Docker network named `homeautomation` with
the backend reachable as `homeautomator` on port 80.

Build directly into mele's k3s image store:

```bash
docker buildx build --builder mele --platform linux/amd64 \
  -f infra/docker/webui/Dockerfile \
  -t quay.io/tsaarni/home-webui:latest \
  --provenance=false --output type=image,push=false,store=true,unpack=true webui
```

To publish to Quay instead, replace the `--provenance=false --output ...` options
with `--push` after logging in.

## Development: install locally on mele

Use `imagePullPolicy: IfNotPresent` in the application Deployments.
After a successful build, force-delete its pods to start the new image.

```bash
# Automator
docker buildx build --builder mele --platform linux/amd64 \
  -f infra/docker/homeautomator/Dockerfile \
  -t quay.io/tsaarni/home-automator:latest \
  --provenance=false --output type=image,push=false,store=true,unpack=true automator && \
  kubectl delete pod -l app=homeautomator --force --grace-period=0 --wait=false

# Metrics
docker buildx build --builder mele --platform linux/amd64 \
  -f infra/docker/homemetrics/Dockerfile \
  -t quay.io/tsaarni/home-metrics:latest \
  --provenance=false --output type=image,push=false,store=true,unpack=true metrics && \
  kubectl delete pod -l app=homemetrics --force --grace-period=0 --wait=false

# Device gateway
docker buildx build --builder mele --platform linux/amd64 \
  -f infra/docker/device-gateway/Dockerfile \
  -t quay.io/tsaarni/home-device-gateway:latest \
  --provenance=false --output type=image,push=false,store=true,unpack=true device-gateway && \
  kubectl delete pod -l app=device-gateway --force --grace-period=0 --wait=false
```

Images are stored directly in mele's k3s image store. Nothing is pushed to Quay.
Force deletion skips graceful shutdown and does not wait for the old process to exit.

## Publish to Quay

```bash
docker login quay.io

# Automator
docker buildx build --builder mele --platform linux/amd64 \
  -f infra/docker/homeautomator/Dockerfile \
  -t quay.io/tsaarni/home-automator:latest --push automator

# Metrics
docker buildx build --builder mele --platform linux/amd64 \
  -f infra/docker/homemetrics/Dockerfile \
  -t quay.io/tsaarni/home-metrics:latest --push metrics

# Device gateway
docker buildx build --builder mele --platform linux/amd64 \
  -f infra/docker/device-gateway/Dockerfile \
  -t quay.io/tsaarni/home-device-gateway:latest --push device-gateway
```

With `IfNotPresent`, a cached local image takes precedence over Quay's `latest`.

## One-time builder configuration

BuildKit runs on `mele`; no local Docker daemon is needed.
Skip creating the namespace and builder if they already exist.

```bash
brew install docker docker-buildx

kubectl create namespace buildkit

docker buildx create --name mele --driver kubernetes \
  --driver-opt namespace=buildkit \
  --driver-opt nodeselector=kubernetes.io/hostname=mele \
  --driver-opt persistent-volume-claim.requests.storage=10Gi \
  --use --bootstrap
```

Switch the existing builder to k3s's containerd worker:

```bash
kubectl -n buildkit patch statefulset mele0 --type=strategic \
  --patch-file infra/docker/buildkit-containerd.patch.yaml
kubectl -n buildkit rollout status statefulset/mele0
kubectl -n buildkit exec mele0-0 -- buildctl debug workers --verbose
```

The worker must report `executor: containerd` and namespace `k8s.io`.
The patch shares the containerd socket, storage and I/O directories with the
already privileged builder. BuildKit state and temporary sockets use the shared
host directory `/var/lib/homeautomation/buildkit-containerd`.
