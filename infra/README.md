# Personal home automation server setup

⚠️ Note: This project is meant for personal use, and is not guaranteed to work for anyone else.

Single-node k3s cluster. All user workloads run in the `default` namespace.

## Install or update k3s

```
curl -sfL https://get.k3s.io | INSTALL_K3S_CHANNEL=stable sh -s - --write-kubeconfig-mode 644 --disable traefik --disable servicelb --disable gateway-api-crd
```

## Change ingress controller to Contour

Disable default ingress controller

```diff
--- /etc/systemd/system/k3s.service.orig 2021-10-03 13:53:22.887426742 +0000
+++ /etc/systemd/system/k3s.service     2021-10-03 13:51:16.218849272 +0000
@@ -29,4 +29,4 @@
 ExecStart=/usr/local/bin/k3s \
     server \
        '--write-kubeconfig-mode=644' \
-
+       --disable traefik \
+       --disable servicelb \
+       --disable gateway-api-crd
```

Restart k3s

```console
sudo systemctl daemon-reload
sudo systemctl restart k3s.service
```

The global kubeconfig file is stored at `/etc/rancher/k3s/k3s.yaml`.

Deploy Contour

```console
kubectl apply -f https://projectcontour.io/quickstart/contour.yaml
```

## Control the cluster from another machine

```console
scp user@host:/etc/rancher/k3s/k3s.yaml ~/.kube/config
chmod 600 ~/.kube/config
sed -i '' 's#https://127.0.0.1:6443#https://NODE_IP:6443#' ~/.kube/config
kubectl get nodes
```

## Store configuration

```console
# homemetrics
kubectl create configmap homemetrics-config --from-file=secrets/homemetrics/config.yaml --dry-run=client -o yaml | kubectl apply -f -

# homeautomator: no ConfigMap. The documents live on the PVC homeautomator-data.
# The old homeautomator-config ConfigMap was removed, see legacy/homeautomator-config.yaml.

# dyndns
kubectl create configmap dyndns-config --from-file=secrets/dyndns-config.yaml --dry-run=client -o yaml | kubectl apply -f -
gcloud iam service-accounts keys create secrets/gcp-dyndns-client-serviceaccount.json --iam-account="dyndns-client@$(gcloud config get project).iam.gserviceaccount.com" --project="$(gcloud config get project)"
kubectl create secret generic dyndns-gcp-key --from-file=secrets/gcp-dyndns-client-serviceaccount.json --dry-run=client -o yaml | kubectl apply -f -

# cloudflared tunnel
kubectl create secret generic cloudflared-token --from-file=secrets/cloudflared-tunnel-token --dry-run=client -o yaml | kubectl apply -f -
```

## Deploy apps

For the Buildx workflow that builds on `mele` and pushes to Quay, see
[docker/README.md](docker/README.md). It covers building and pushing both services, and the builder setup.

### home-automator

The application source is in `../automator`. This directory holds the image recipe
(`docker/homeautomator/`) and the manifest (`manifests/homeautomator.yaml`).

```console
kubectl apply -f manifests/homeautomator.yaml # apply after updating the image tag
kubectl exec deploy/homeautomator -- python /opt/seed/install.py /data   # install or update the documents
kubectl logs deploy/homeautomator --tail=20
kubectl port-forward svc/homeautomator 8080:80 &
curl -s localhost:8080/readyz | python3 -m json.tool
```

Add the tunnel route `automator.home.protonode.fi -> http://homeautomator:80` in Cloudflare
Zero Trust, with an Access policy. The app has no authentication.

Notes

* The documents (devices, groups, rules) live on the PVC `homeautomator-data`, not in a
  ConfigMap. They are JSON files: `config.json`, `pending.json`, `events.jsonl`.
* `/opt/seed` inside the image holds the seed documents and the installer. See
  `../automator/seed/README.md` for how they are extracted from the gateways.
* The Deployment uses one replica and `strategy: Recreate`, because the service is a single
  writer of its files.
* Update the manifest to the image tag pushed to Quay, then apply it to deploy a build.
* To rehearse instead of writing to the devices: `kubectl set env deployment/homeautomator
  DRY_RUN=true` and read `/api/v1/events` for `dry-run` writes.

## Tips

### Storage

Host mounts are used for local storage.
K3s persistent volumes can be directly accessed on host under directory `/var/lib/rancher/k3s/storage/`

### VictoriaMetrics

VictoriamMtrics might go into crashloop after upgrade with error

```
FATAL: cannot create lock file: cannot acquire lock on file "/victoria-metrics-data/flock.lock": resource temporarily unavailable; make sure a single process has exclusive access to "/victoria-metrics-data"
```

```console
kubectl scale deployment victoriametrics --replicas 0
kubectl scale deployment victoriametrics --replicas 1
```

## Backup

```console
mkdir -p backup
BACKUP_TIMESTAMP=$(date +"%Y-%m-%dT%H.%M.%S")
kubectl exec deployment/zigbee2mqtt -c zigbee2mqtt -- tar zvcf - /app/data/ > backup/$BACKUP_TIMESTAMP-zigbee2mqtt.tar.gz
kubectl exec deployment/zwave2mqtt -- tar zvcf - /usr/src/app/store > backup/$BACKUP_TIMESTAMP-zwave2mqtt.tar.gz
kubectl exec deployment/grafana -- tar zvcf - /var/lib/grafana > backup/$BACKUP_TIMESTAMP-grafana.tar.gz
kubectl exec deployment/victoriametrics -- tar zvcf - /victoria-metrics-data > backup/$BACKUP_TIMESTAMP-victoriametrics.tar.gz
kubectl exec deployment/homeautomator -- tar zvcf - /data > backup/$BACKUP_TIMESTAMP-homeautomator.tar.gz
```

## Adding new zigbee device

- https://www.zigbee2mqtt.io/advanced/support-new-devices/01_support_new_devices.html#_2-adding-your-device
  https://github.com/Koenkk/zigbee2mqtt/issues?q=is%3Aissue+is%3Aopen+TS011F
  https://www.zigbee2mqtt.io/devices/TS011F_plug_3.html#options

## VictoriaMetrics

- MetricsQL language reference https://github.com/VictoriaMetrics/VictoriaMetrics/wiki/MetricsQL
