# Deploying home-automator v2

One replica, one PVC, a plain `Service`; exposure is a Cloudflare Tunnel route
(`automator.home.protonode.fi -> http://automator:80`), so there is no Contour/HTTPProxy
and no auth inside the app.

## Build and push

```bash
podman build -f deploy/Dockerfile -t quay.io/tsaarni/home-automator:v2 .
podman push quay.io/tsaarni/home-automator:v2
```

## Install

```bash
kubectl apply -f deploy/app.yaml
kubectl exec deploy/automator -- python -c "import json,pathlib; print(json.loads(pathlib.Path('/data/config.json').read_text()).keys())"
```

## Seed a fresh PVC

The seed documents are not baked into the image; install them once (see [../seed/README.md](../seed/README.md)
for how the documents are extracted from the gateways):

```bash
kubectl cp seed deploy/automator:/tmp/seed
kubectl exec deploy/automator -- python /tmp/seed/install.py /data
kubectl rollout restart deploy/automator
```

Or build the config by hand from the same JSON through the API.

## Cutover rehearsal

Set `DRY_RUN=true` (env or `POST /api/v1/dry-run {"enabled": true}`) and compare
`/api/v1/events` against the old app's behaviour before letting v2 write.
