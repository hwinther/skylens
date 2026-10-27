# deploy/

Workload manifests for the skylens API. On every release, the `manifests` job in
`.github/workflows/container.yml`:

1. renders this directory, with the API image pinned to `tag@digest`;
2. validates the output with kubeconform;
3. pushes it as an OCI artifact to `ghcr.io/hwinther/skylens/manifests:<version>`;
4. signs it with cosign (keyless).

On pull requests, `manifest-diff.yml` posts the rendered diff against the base branch to the job
summary. Don't commit rendered output.

The cluster repo (hwinther/proxmox) consumes the artifact through a Flux `OCIRepository` and
`Kustomization`. It provides everything that isn't in here:

- the namespace (via `targetNamespace`) and network policies;
- the Secret;
- the variable values below (via `postBuild.substitute`).

## Contract

### Variables

CI fails if the rendered output contains a variable without a default that isn't listed here.
Flux would otherwise substitute an empty string. Only substitute string values: kustomize drops
quotes, so a number or boolean would come out as the wrong YAML type.

| Variable | Default | Used for |
|---|---|---|
| `APP_HOST` | (required) | Ingress host and homepage links, e.g. `skylens.wsh.no` |
| `OIDC_AUTHORITY` | (required) | `Oidc__Authority`, the JWT issuer, e.g. `https://auth.wsh.no` |
| `OIDC_AUDIENCE` | `skylens-api` | `Oidc__Audience` |
| `MQTT_HOST` | (required) | Broker carrying `adsb/aircraft` and `ais/data` |
| `OTEL_EXPORTER_OTLP_ENDPOINT` | (required) | OTLP gRPC collector endpoint |
| `APP_ENVIRONMENT` | `production` | `deployment.environment` resource attribute |

### Secret

`skylens-secrets` in the target namespace, loaded with `envFrom`. Keys:

- `MQTT__USERNAME`, `MQTT__PASSWORD`
- `OPENSKY__CLIENTID`, `OPENSKY__CLIENTSECRET`
- `ADSBX__RAPIDAPIKEY`
- `AEROAPI__APIKEY`
- `FEED__LAT`, `FEED__LON`, `FEED__RADIUSKM`

### Resource names

`Deployment/skylens-api`, `Service/skylens-api`, `Ingress/skylens`. Flux prunes anything that
disappears from the artifact, so rename deliberately.

## Render locally

```bash
.github/scripts/render-manifests.sh deploy /tmp/skylens.yaml
```
