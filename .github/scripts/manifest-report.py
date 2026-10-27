#!/usr/bin/env python3
"""Builds the Markdown review report for a rendered manifest change.

    manifest-report.py <base.jsonl> <head.jsonl> [run-url]

Inputs are rendered manifests as one JSON document per line (`yq -o=json -I=0 '.'`). The report
has a change summary, a Mermaid map of how the resources wire together (Ingress -> Service ->
workload -> Secret/ConfigMap/PVC) coloured by change, and a collapsible dyff per changed resource.
References to objects outside the rendered set (the Secrets the cluster repo provides) show as
dashed external nodes, so the deploy contract is visible too. dyff must be on PATH.
"""

import json
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path

MARKER = "<!-- manifest-diff -->"
# PR comments are capped at 65536 characters; leave room for the closing note.
BUDGET = 60000
WORKLOADS = {"Deployment", "StatefulSet", "DaemonSet", "ReplicaSet", "Job", "CronJob"}


def load(path):
    objs = {}
    for line in Path(path).read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if not line or line == "null":
            continue
        obj = json.loads(line)
        objs[key(obj)] = obj
    return objs


def key(obj):
    meta = obj.get("metadata", {})
    ns = meta.get("namespace")
    return f"{obj['kind']}/{ns + '/' if ns else ''}{meta.get('name', '')}"


def pod_template(obj):
    spec = obj.get("spec", {})
    if obj["kind"] == "CronJob":
        return spec.get("jobTemplate", {}).get("spec", {}).get("template", {})
    return spec.get("template", {}) if obj["kind"] in WORKLOADS else {}


def refs(obj):
    """Yields (kind, name, label) for everything this object points at by name."""
    kind, spec = obj["kind"], obj.get("spec", {})
    if kind == "Ingress":
        by_svc = {}
        default = spec.get("defaultBackend", {}).get("service", {}).get("name")
        if default:
            by_svc.setdefault(default, []).append("default")
        for rule in spec.get("rules", []):
            for p in rule.get("http", {}).get("paths", []):
                svc = p.get("backend", {}).get("service", {}).get("name")
                if svc:
                    by_svc.setdefault(svc, []).append(p.get("path", "/"))
        for svc, paths in by_svc.items():
            yield "Service", svc, " ".join(paths)
    elif kind == "HTTPRoute":
        for rule in spec.get("rules", []):
            for b in rule.get("backendRefs", []):
                yield b.get("kind", "Service"), b["name"], ""
    elif kind == "HorizontalPodAutoscaler":
        target = spec.get("scaleTargetRef", {})
        yield target.get("kind"), target.get("name"), "scales"

    pod = pod_template(obj).get("spec", {})
    if not pod:
        return
    if pod.get("serviceAccountName"):
        yield "ServiceAccount", pod["serviceAccountName"], ""
    for s in pod.get("imagePullSecrets", []):
        yield "Secret", s["name"], "pull"
    for v in pod.get("volumes", []):
        if "secret" in v:
            yield "Secret", v["secret"]["secretName"], "volume"
        if "configMap" in v:
            yield "ConfigMap", v["configMap"]["name"], "volume"
        if "persistentVolumeClaim" in v:
            yield "PersistentVolumeClaim", v["persistentVolumeClaim"]["claimName"], ""
    for c in pod.get("initContainers", []) + pod.get("containers", []):
        for e in c.get("envFrom", []):
            if "secretRef" in e:
                yield "Secret", e["secretRef"]["name"], "env"
            if "configMapRef" in e:
                yield "ConfigMap", e["configMapRef"]["name"], "env"
        for e in c.get("env", []):
            src = e.get("valueFrom", {})
            if "secretKeyRef" in src:
                yield "Secret", src["secretKeyRef"]["name"], "env"
            if "configMapKeyRef" in src:
                yield "ConfigMap", src["configMapKeyRef"]["name"], "env"


def selects(selector, obj):
    labels = pod_template(obj).get("metadata", {}).get("labels", {})
    return bool(selector) and all(labels.get(k) == v for k, v in selector.items())


def edges(objs):
    """Edges between keys in objs, plus (kind, name) targets that aren't in objs."""
    by_name = {(o["kind"], o["metadata"].get("name")): k for k, o in objs.items()}
    out = set()
    for k, obj in objs.items():
        for kind, name, label in refs(obj):
            out.add((k, by_name.get((kind, name), f"ext:{kind}/{name}"), label))
        selector = None
        if obj["kind"] == "Service":
            selector = obj.get("spec", {}).get("selector")
        elif obj["kind"] == "PodDisruptionBudget":
            selector = obj.get("spec", {}).get("selector", {}).get("matchLabels")
        for k2, o2 in objs.items():
            if selects(selector, o2):
                out.add(
                    (k, k2, "protects" if obj["kind"] == "PodDisruptionBudget" else "")
                )
    return out


def label(text):
    return text.replace('"', "#quot;")


def short_image(image):
    return image.split("@")[0].rsplit("/", 1)[-1]


def mermaid(base, head, status):
    shown = {**{k: base[k] for k in status if status[k] == "removed"}, **head}
    all_edges = edges(head) | {e for e in edges(base) if status.get(e[0]) == "removed"}
    ids = {k: f"n{i}" for i, k in enumerate(sorted(shown))}
    lines = ["```mermaid", "graph LR"]
    for k in sorted(shown):
        obj = shown[k]
        text = k
        images = [
            c["image"] for c in pod_template(obj).get("spec", {}).get("containers", [])
        ]
        if images:
            text += "<br/>" + "<br/>".join(short_image(i) for i in images)
        lines.append(f'  {ids[k]}["{label(text)}"]:::{status[k]}')
    for target in sorted({t for _, t, _ in all_edges if t.startswith("ext:")}):
        ids[target] = f"x{len(ids)}"
        lines.append(f'  {ids[target]}(["{label(target[4:])}"]):::external')
    for src, dst, text in sorted(all_edges):
        arrow = "-.->" if dst.startswith("ext:") else "-->"
        if text:
            arrow += f'|"{label(text)}"|'
        lines.append(f"  {ids[src]} {arrow} {ids[dst]}")
    lines += [
        "  classDef added fill:#d3f9d8,stroke:#2b8a3e,color:#1b4332",
        "  classDef changed fill:#fff3bf,stroke:#e67700,color:#5c3c00",
        "  classDef removed fill:#ffe3e3,stroke:#c92a2a,color:#5c0011,stroke-dasharray:4",
        "  classDef unchanged fill:#f1f3f5,stroke:#868e96,color:#212529",
        "  classDef external fill:none,stroke:#868e96,color:#495057,stroke-dasharray:4",
        "```",
    ]
    return "\n".join(lines)


def dyff(old, new, tmp):
    a, b = Path(tmp, "from.json"), Path(tmp, "to.json")
    a.write_text(json.dumps(old), encoding="utf-8")
    b.write_text(json.dumps(new), encoding="utf-8")
    result = subprocess.run(
        [
            shutil.which("dyff") or "dyff",
            "between",
            "--omit-header",
            "--output",
            "github",
            "--color",
            "off",
            str(a),
            str(b),
        ],
        capture_output=True,
        text=True,
        encoding="utf-8",
        check=True,
    )
    return result.stdout.strip()


def as_yaml(obj):
    """yq ships on the GitHub runners; fall back to JSON where it doesn't."""
    try:
        text = subprocess.run(
            ["yq", "-p=json", "-o=yaml", "-P", "."],
            input=json.dumps(obj),
            capture_output=True,
            text=True,
            encoding="utf-8",
            check=True,
        ).stdout.strip()
        return f"```yaml\n{text}\n```"
    except (OSError, subprocess.CalledProcessError):
        return f"```json\n{json.dumps(obj, indent=2)}\n```"


def main():
    base, head = load(sys.argv[1]), load(sys.argv[2])
    run_url = sys.argv[3] if len(sys.argv) > 3 else ""
    status = {}
    for k in base.keys() | head.keys():
        if k not in base:
            status[k] = "added"
        elif k not in head:
            status[k] = "removed"
        else:
            same = json.dumps(base[k], sort_keys=True) == json.dumps(
                head[k], sort_keys=True
            )
            status[k] = "unchanged" if same else "changed"

    counts = {
        s: sum(1 for v in status.values() if v == s)
        for s in ("changed", "added", "removed", "unchanged")
    }
    summary = ", ".join(f"{n} {s}" for s, n in counts.items() if n)
    parts = [
        MARKER,
        "### Rendered manifests",
        "",
        f"{summary}."
        if any(counts[s] for s in ("changed", "added", "removed"))
        else f"No change to the rendered manifests ({summary}).",
        "",
        mermaid(base, head, status),
    ]

    sections = []
    with tempfile.TemporaryDirectory() as tmp:
        for k in sorted(
            status,
            key=lambda k: (
                ["changed", "added", "removed"].index(status[k])
                if status[k] != "unchanged"
                else 3,
                k,
            ),
        ):
            if status[k] == "changed":
                body = f"```diff\n{dyff(base[k], head[k], tmp)}\n```"
            elif status[k] == "added":
                body = as_yaml(head[k])
            elif status[k] == "removed":
                body = "Pruned by Flux when this version is applied."
            else:
                continue
            sections.append(
                f"<details><summary><b>{status[k]}</b> {k}</summary>\n\n{body}\n\n</details>"
            )

    report = "\n".join(parts) + "\n"
    for i, section in enumerate(sections):
        if len(report) + len(section) > BUDGET:
            report += f"\n_{len(sections) - i} more resource(s) left out for size"
            report += f"; see the [workflow run]({run_url})._\n" if run_url else "._\n"
            break
        report += "\n" + section + "\n"
    if run_url:
        report += f"\n<sub>Placeholder image tag; the release job pins tag@digest. [Run]({run_url})</sub>\n"
    sys.stdout.write(report)


if __name__ == "__main__":
    main()
