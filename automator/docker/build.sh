#!/usr/bin/env bash
#
# build.sh - build any image in docker/ on the k3s node and load it into containerd.
#
# WHAT IT DOES
#   1. reads docker/<name>/image.conf for the context, tag and deployment
#   2. packs the build context into a tar
#   3. starts a temporary privileged pod on the k3s node
#   4. runs "podman build" inside that pod, so the build happens on the node
#   5. loads the image into the k3s containerd store, so no registry is needed
#   6. deletes the build pod and, when the image has a Deployment, restarts it
#
# WHY THIS WAY
#   The images must be linux/amd64 and the node is the only amd64 build host. The privileged
#   pod replaces ssh, sudo and an image registry, so kubectl is the only requirement.
#
# REQUIREMENTS
#   kubectl access to the cluster, and a node that runs k3s. No local container runtime.
#
# EXAMPLES
#   docker/build.sh --list                 # which images can be built, and their settings
#   docker/build.sh homeautomator          # build, load, restart deployment/homeautomator
#   docker/build.sh homeautomator --no-restart   # build and load only
#   docker/build.sh homeautomator --dry-run      # print the resolved settings, build nothing
#   docker/build.sh homeautomator --tag test --keep
#
# OPTIONS
#   NAME                image to build: a directory under docker/ that has a Dockerfile
#   --list              list the images and their settings, then exit
#   --dry-run           print the resolved settings, then exit
#   --tag TAG           image tag (default: TAG from image.conf, else NAME:latest)
#   --context DIR       build context (default: CONTEXT from image.conf, else docker/NAME)
#   --dockerfile FILE   Dockerfile (default: docker/NAME/Dockerfile)
#   --deployment NAME   deployment to restart (default: DEPLOYMENT from image.conf)
#   --node NAME         node that builds and runs the image (default mele)
#   --builder IMAGE     builder image (default quay.io/podman/stable:latest)
#   --pod NAME          name of the temporary build pod (default NAME-build)
#   --cache-dir DIR     build cache on the node (default /var/lib/rancher/NAME-build/podman)
#   --no-cache          pass --no-cache to podman build
#   --no-restart        do not restart the deployment
#   --keep              keep the build pod
#   -h, --help          print this text
#
# IMAGE CONFIGURATION: docker/NAME/image.conf, a shell snippet that can set
#   CONTEXT         directory to build from (default: docker/NAME)
#   CONTEXT_FILES   space separated files inside CONTEXT to pack (default: everything)
#   TAG             image tag; keep it equal to the image field of the manifest
#   DEPLOYMENT      deployment to restart after loading (default: none)
#   DOCKERFILE, NODE, POD, BUILDER_IMAGE, CACHE_DIR   optional overrides
#
# NOTES
#   The build pod is privileged and mounts the host root, because it must reach the k3s
#   containerd socket. Run it only from a trusted machine.
#   The layer cache stays on the node, so a rebuild with a warm cache is quick.
#   The image is loaded, not pulled. Keep the tag equal to the manifest image field
#   (imagePullPolicy: IfNotPresent).

set -euo pipefail

INFRA_DIR="$(cd "$(dirname "$0")/.." && pwd)"
NODE="mele"
BUILDER_IMAGE="quay.io/podman/stable:latest"
NAME=""
TAG=""
CONTEXT=""
CONTEXT_FILES=""
DOCKERFILE=""
DEPLOYMENT=""
POD=""
CACHE_DIR=""
NO_CACHE=0
RESTART=1
KEEP=0
DRY_RUN=0
LIST=0
EXTRA=""

usage() { sed -n '2,/^$/p' "$0" | sed -e 's/^#[ ]\{0,1\}//'; }

die() { echo "$*" >&2; exit 1; }

need_value() { [ "$#" -ge 2 ] || die "option $1 needs a value"; }

conf_value() {   # conf_value FILE KEY -> value, empty when unset
  local file="$1" key="$2"
  [ -f "$file" ] || return 0
  ( set +u; . "$file" >/dev/null 2>&1 || true; eval "printf '%s' \"\$$key\"" )
}

image_names() {
  local dir
  for dir in "$INFRA_DIR"/docker/*/; do
    [ -f "$dir/Dockerfile" ] || continue
    basename "$dir"
  done
}

show_image() {   # show_image NAME
  local name="$1" conf context dockerfile tag deployment
  conf="$INFRA_DIR/docker/$name/image.conf"
  context="$(conf_value "$conf" CONTEXT)"
  dockerfile="$(conf_value "$conf" DOCKERFILE)"
  tag="$(conf_value "$conf" TAG)"
  deployment="$(conf_value "$conf" DEPLOYMENT)"
  [ -n "$context" ] || context="docker/$name"
  [ -n "$dockerfile" ] || dockerfile="docker/$name/Dockerfile"
  [ -n "$tag" ] || tag="$name:latest"
  [ -n "$deployment" ] || deployment="-"
  printf '  %-12s tag=%-40s deployment=%-12s context=%s\n' "$name" "$tag" "$deployment" "$context"
}

while [ "$#" -gt 0 ]; do
  case "$1" in
    --list) LIST=1; shift ;;
    --dry-run) DRY_RUN=1; shift ;;
    --tag) need_value "$@"; TAG="$2"; shift 2 ;;
    --context) need_value "$@"; CONTEXT="$2"; shift 2 ;;
    --dockerfile) need_value "$@"; DOCKERFILE="$2"; shift 2 ;;
    --deployment) need_value "$@"; DEPLOYMENT="$2"; shift 2 ;;
    --node) need_value "$@"; NODE="$2"; shift 2 ;;
    --builder) need_value "$@"; BUILDER_IMAGE="$2"; shift 2 ;;
    --pod) need_value "$@"; POD="$2"; shift 2 ;;
    --cache-dir) need_value "$@"; CACHE_DIR="$2"; shift 2 ;;
    --no-cache) NO_CACHE=1; shift ;;
    --no-restart) RESTART=0; shift ;;
    --keep) KEEP=1; shift ;;
    -h|--help) usage; exit 0 ;;
    -*) die "unknown option: $1" ;;
    *) NAME="$1"; shift ;;
  esac
done

if [ "$LIST" -eq 1 ]; then
  echo "images in docker/ (use: docker/build.sh NAME):"
  for name in $(image_names); do show_image "$name"; done
  exit 0
fi
[ -n "$NAME" ] || { usage; exit 2; }
[ -d "$INFRA_DIR/docker/$NAME" ] || die "unknown image: $NAME (try --list)"

CONF="$INFRA_DIR/docker/$NAME/image.conf"
[ -n "$CONTEXT" ] || CONTEXT="$(conf_value "$CONF" CONTEXT)"
[ -n "$CONTEXT" ] || CONTEXT="$INFRA_DIR/docker/$NAME"
# expand a leading ~ or $HOME that the conf file wrote
eval "CONTEXT=\"$CONTEXT\""
[ -n "$CONTEXT_FILES" ] || CONTEXT_FILES="$(conf_value "$CONF" CONTEXT_FILES)"
[ -n "$DOCKERFILE" ] || DOCKERFILE="$(conf_value "$CONF" DOCKERFILE)"
[ -n "$DOCKERFILE" ] || DOCKERFILE="$INFRA_DIR/docker/$NAME/Dockerfile"
[ -n "$TAG" ] || TAG="$(conf_value "$CONF" TAG)"
[ -n "$TAG" ] || TAG="$NAME:latest"
[ -n "$DEPLOYMENT" ] || DEPLOYMENT="$(conf_value "$CONF" DEPLOYMENT)"
[ -n "$NODE" ] || NODE="$(conf_value "$CONF" NODE)"
[ -n "$POD" ] || POD="$(conf_value "$CONF" POD)"
[ -n "$POD" ] || POD="$NAME-build"
[ -n "$BUILDER_IMAGE" ] || BUILDER_IMAGE="$(conf_value "$CONF" BUILDER_IMAGE)"
[ -n "$BUILDER_IMAGE" ] || BUILDER_IMAGE="quay.io/podman/stable:latest"
[ -n "$CACHE_DIR" ] || CACHE_DIR="$(conf_value "$CONF" CACHE_DIR)"
[ -n "$CACHE_DIR" ] || CACHE_DIR="/var/lib/rancher/$NAME-build/podman"

SHOWN_FILES="$CONTEXT_FILES"
[ -n "$SHOWN_FILES" ] || SHOWN_FILES="<all>"
SHOWN_DEPLOYMENT="$DEPLOYMENT"
[ -n "$SHOWN_DEPLOYMENT" ] || SHOWN_DEPLOYMENT="<none>"

say() { printf '\n==> %s\n' "$*"; }

say "image $NAME"
printf '    tag         %s\n    context     %s\n    dockerfile  %s\n    files       %s\n    node        %s\n    pod         %s\n    cache       %s\n    deployment  %s\n' \
  "$TAG" "$CONTEXT" "$DOCKERFILE" "$SHOWN_FILES" "$NODE" "$POD" "$CACHE_DIR" "$SHOWN_DEPLOYMENT"

[ -d "$CONTEXT" ] || die "context not found: $CONTEXT"
[ -f "$DOCKERFILE" ] || die "dockerfile not found: $DOCKERFILE"
[ -n "$NODE" ] || die "no node given, use --node"

if [ "$DRY_RUN" -eq 1 ]; then
  say "dry run, nothing built"
  exit 0
fi

WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

say "pack the build context"
# shellcheck disable=SC2086
tar -czf "$WORK/context.tgz" -C "$CONTEXT" \
  --exclude='.git' --exclude='.venv' --exclude='__pycache__' --exclude='*.pyc' --exclude='data' \
  $CONTEXT_FILES
cp "$DOCKERFILE" "$WORK/Dockerfile"
du -h "$WORK/context.tgz" | sed 's/^/    /'

say "start build pod $POD on node $NODE (builder: $BUILDER_IMAGE)"
kubectl delete pod "$POD" --ignore-not-found --wait=true >/dev/null 2>&1 || true
kubectl apply -f - <<YAML
apiVersion: v1
kind: Pod
metadata:
  name: $POD
  labels:
    app.kubernetes.io/name: $NAME-build
spec:
  nodeName: $NODE
  restartPolicy: Never
  terminationGracePeriodSeconds: 5
  containers:
    - name: builder
      image: $BUILDER_IMAGE
      command: ["sleep", "infinity"]
      securityContext:
        privileged: true
        runAsUser: 0
      volumeMounts:
        - name: host
          mountPath: /host
        - name: cache
          mountPath: /var/lib/containers
        - name: workspace
          mountPath: /build
  volumes:
    - name: host
      hostPath:
        path: /
    - name: cache
      hostPath:
        path: $CACHE_DIR
        type: DirectoryOrCreate
    - name: workspace
      emptyDir: {}
YAML
kubectl wait --for=condition=Ready "pod/$POD" --timeout=600s | sed 's/^/    /'

say "copy the context into the pod"
kubectl cp "$WORK/context.tgz" "$POD:/tmp/context.tgz"
kubectl cp "$WORK/Dockerfile" "$POD:/build/Dockerfile"
kubectl exec "$POD" -- tar -xzf /tmp/context.tgz -C /build

say "build $TAG inside the cluster"
if [ "$NO_CACHE" -eq 1 ]; then EXTRA="--no-cache"; fi
kubectl exec "$POD" -- sh -c "cd /build && podman build --log-level=warn $EXTRA -f Dockerfile -t $TAG ." \
  | tail -5 | sed 's/^/    /'

say "load $TAG into the k3s containerd store"
# the tar must be on the host filesystem, because ctr runs inside the host chroot
kubectl exec "$POD" -- sh -c "podman save --quiet --format docker-archive -o /host/tmp/$NAME-image.tar $TAG \
  && chroot /host k3s ctr -n k8s.io images import /tmp/$NAME-image.tar \
  && rm -f /host/tmp/$NAME-image.tar" | tail -2 | sed 's/^/    /'
kubectl exec "$POD" -- sh -c "chroot /host k3s ctr -n k8s.io images ls | grep -F '$TAG'" | sed 's/^/    /'

if [ "$KEEP" -eq 0 ]; then
  say "remove the build pod"
  kubectl delete pod "$POD" --wait=false >/dev/null
else
  say "keeping the build pod $POD"
fi

if [ "$RESTART" -eq 1 ] && [ -n "$DEPLOYMENT" ]; then
  if kubectl get deployment "$DEPLOYMENT" >/dev/null 2>&1; then
    say "restart deployment/$DEPLOYMENT"
    kubectl rollout restart deployment/"$DEPLOYMENT" >/dev/null
    kubectl rollout status deployment/"$DEPLOYMENT" --timeout=300s | sed 's/^/    /'
  else
    say "deployment/$DEPLOYMENT does not exist, nothing to restart"
  fi
fi

say "done: $TAG"
