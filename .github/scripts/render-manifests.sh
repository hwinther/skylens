#!/usr/bin/env bash
# Renders deploy/ into a single manifest file and checks the variable contract.
#
#   render-manifests.sh <deploy-dir> <out-file> [image-ref] [component]
#
# image-ref (registry/name:tag@sha256:...) pins the API image; omit it (or pass "") to keep the
# placeholder tag (PR diffs). component is a path under deploy-dir, e.g. components/preview. The contract check fails when the rendered output contains a ${VAR} without a
# default that README.md does not document, because Flux substitutes undefined variables with
# an empty string instead of failing.
set -euo pipefail

src="$(cd "$1" && pwd)"
out="$2"
image="${3:-}"
component="${4:-}"

work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT
mkdir -p "$work/overlay" "$(dirname "$out")"
cp -r "$src" "$work/base"

{
  echo "apiVersion: kustomize.config.k8s.io/v1beta1"
  echo "kind: Kustomization"
  echo "resources:"
  echo "- ../base"
  if [ -n "$image" ]; then
    name="${image%%:*}"
    rest="${image#*:}"
    echo "images:"
    echo "- name: $name"
    echo "  newTag: ${rest%%@*}"
    echo "  digest: ${rest#*@}"
  fi
  if [ -n "$component" ]; then
    echo "components:"
    echo "- ../base/$component"
  fi
} > "$work/overlay/kustomization.yaml"

kubectl kustomize "$work/overlay" > "$out"

missing=0
for var in $(grep -oE '\$\{[A-Za-z_][A-Za-z0-9_]*\}' "$out" | tr -d '${}' | sort -u); do
  if ! grep -q "\`$var\`" "$src/README.md"; then
    echo "::error file=deploy/README.md::\${$var} has no default and is not documented in deploy/README.md"
    missing=1
  fi
done
exit "$missing"
