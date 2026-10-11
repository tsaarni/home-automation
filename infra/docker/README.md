# Container builds

## Compile and push

Run from the repository root. Choose a fresh tag for each build.

```bash
docker login quay.io

docker buildx build --builder mele --platform linux/amd64 \
  -f infra/docker/homeautomator/Dockerfile \
  -t "quay.io/tsaarni/home-automator:latest" --push automator

docker buildx build --builder mele --platform linux/amd64 \
  -f infra/docker/homemetrics/Dockerfile \
  -t "quay.io/tsaarni/home-metrics:latest" --push metrics
```

## Setup

The Mac uses Docker CLI and Buildx with the existing kubeconfig. BuildKit runs
on the Kubernetes node `mele`, in namespace `buildkit`, with a 10 GiB persistent
cache. It builds amd64 images and pushes directly to Quay; no local Docker daemon
is needed.

Tools installed on the Mac:

```bash
brew install docker docker-buildx
```

Docker finds the Homebrew plugin through `~/.docker/config.json`:

```json
{
  "cliPluginsExtraDirs": ["/opt/homebrew/lib/docker/cli-plugins"]
}
```

The builder was created and selected with:

```bash
kubectl create namespace buildkit

docker buildx create --name mele --driver kubernetes \
  --driver-opt namespace=buildkit \
  --driver-opt nodeselector=kubernetes.io/hostname=mele \
  --driver-opt persistent-volume-claim.requests.storage=10Gi \
  --use --bootstrap
```
