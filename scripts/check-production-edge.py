#!/usr/bin/env python3
"""Exercise the actual production Caddy routes against isolated local services.

Requires Docker, Node 20+, and the existing custom Caddy image (EDGE_IMAGE).
No Fly access, shared Redis database, or TLS certificate issuance is involved.
"""
import http.client
import json
import os
from pathlib import Path
import socket
import subprocess
import tempfile
import time
import uuid

ROOT = Path(__file__).resolve().parent.parent
IMAGE = os.environ.get("EDGE_IMAGE", "dhimora-egress-caddy-test:latest")
CADDYFILE = Path(os.environ.get("EDGE_CONFIG", ROOT / "Caddyfile")).resolve()
PORTS = {"edge": 18137, "http": 18138, "admin": 12137, "purge": 19000,
         "redis": 16387, "production": 19387, "preprod": 19388}


def run(*args, **kwargs):
    return subprocess.run(args, check=True, text=True, **kwargs)


def request(port, path, method="GET", headers=None):
    connection = http.client.HTTPConnection("127.0.0.1", port, timeout=10)
    try:
        connection.request(method, path, headers={"Host": "guard.edge.test", **(headers or {})})
        response = connection.getresponse()
        return response.status, {k.lower(): v for k, v in response.getheaders()}, response.read()
    finally:
        connection.close()


def wait_ready(port, path):
    for _ in range(80):
        try:
            if request(port, path)[0] == 200:
                return
        except OSError:
            pass
        time.sleep(0.1)
    raise RuntimeError(f"listener {port} did not become ready")


def assert_safe(condition, message):
    if not condition:
        raise AssertionError(message)
    print(f"PASS {message}", flush=True)


def local_config(config):
    """Change infrastructure only; leave adapted matchers, cache and proxy routes intact."""
    config.pop("storage")  # Certificate storage is irrelevant without TLS in this harness.
    config["apps"].pop("tls")
    config["admin"]["listen"] = f"127.0.0.1:{PORTS['admin']}"
    config["admin"]["origins"] = [f"localhost:{PORTS['admin']}", f"127.0.0.1:{PORTS['admin']}"]
    for server in config["apps"]["http"]["servers"].values():
        ports = {":443": PORTS["edge"], ":80": PORTS["http"], ":9000": PORTS["purge"]}
        server["listen"] = [f"127.0.0.1:{ports[address]}" for address in server["listen"]]
        server.pop("tls_connection_policies", None)
        server["automatic_https"] = {"disable": True}
    # Use the same URL parser as production, with a disposable Redis instance.
    assert config["apps"]["cache"]["redis"]["url"] == f"127.0.0.1:{PORTS['redis']}"

    def remap_admin(value):
        if isinstance(value, dict):
            return {key: remap_admin(item) for key, item in value.items()}
        if isinstance(value, list):
            return [remap_admin(item) for item in value]
        return {"127.0.0.1:2019": f"127.0.0.1:{PORTS['admin']}",
                "localhost:2019": f"localhost:{PORTS['admin']}"}.get(value, value) if isinstance(value, str) else value

    return remap_admin(config)


def extra_checks():
    edge = PORTS["edge"]
    for port in (PORTS["http"], edge):
        for path in ("/__cache", "/__cache/souin/", "/__cache/souin/surrogate_keys"):
            for method in ("GET", "PURGE", "POST"):
                status, _, _ = request(port, path, method, {"X-Forwarded-For": "127.0.0.1"})
                assert_safe(status == 403, f"public :{port} rejects {method} {path}")
    for path in ("/config/", "/load", "/stop", "/metrics"):
        status, _, _ = request(PORTS["purge"], path)
        assert_safe(status == 404, f"private purge listener rejects admin path {path}")
    status, _, _ = request(PORTS["purge"], "/__cache/souin/")
    assert_safe(status == 200, "private purge listener forwards the Souin API")
    status, headers, _ = request(PORTS["http"], "/category/shoes?x=1")
    assert_safe(status == 301 and headers.get("location") == "https://guard.edge.test/category/shoes?x=1",
                "public HTTP still redirects storefront requests to HTTPS")
    assert_safe(request(PORTS["http"], "/health")[2] == b"ok", "public HTTP health check still works")

    for host, expected in (("prod.edge.test", "sin-01"), ("store.test.dhimora.com", "sin-01-test")):
        _, _, _ = request(edge, "/category/shoes", headers={"Host": host})
        _, warm_headers, _ = request(edge, "/category/shoes", headers={"Host": host})
        assert_safe("; hit;" in warm_headers.get("cache-status", ""), f"{host} has a warm page")
        assert_safe(warm_headers.get("x-dhimora-edge") == expected, f"{host} uses its own upstream route")
        assert_safe("edge-safe-v1-" in warm_headers.get("cache-status", ""), "cache key has the new policy namespace")
        status, _, body = request(edge, "/category/shoes", "HEAD", {"Host": host})
        assert_safe(status == 200 and body == b"", "HEAD returns headers without a body")
        _, headers, body = request(edge, "/category/shoes", headers={"Host": host})
        assert_safe("; hit;" in headers.get("cache-status", "") and len(body) > 0, "HEAD cannot replace the cached GET body")
        _, headers, _ = request(edge, "/category/shoes", "POST", {"Host": host})
        assert_safe("cache-status" not in headers, "POST bypasses the page cache")
        for header in (
            {"Cookie": "unknown-personalization=visitor"},
            {"Cookie": "__drk__session_token.0=visitor; __drk__session_token.1=secret"},
            {"Cookie": "__Secure-next-auth.session-token.0=visitor"},
            {"Cookie": "__drk_session_id=visitor"},
            {"Authorization": "Bearer visitor"},
        ):
            _, headers, body = request(edge, "/category/shoes", headers={"Host": host, **header})
            assert_safe("hit" not in headers.get("cache-status", "") and b"visitor" in body,
                        f"{host} preserves and bypasses {next(iter(header.values())).split('=')[0]}")
            assert_safe("no-store" in headers.get("cache-control", ""), "personalized response is no-store downstream")
        _, headers, body = request(edge, "/category/shoes", headers={"Host": host})
        assert_safe("; hit;" in headers.get("cache-status", "") and b"visitor" not in body,
                    "personalized requests leave the public entry unchanged")
        for path in ("/private-leak", "/error-404", "/error-504", "/partial-content", "/redirect-page"):
            responses = [request(edge, path, headers={"Host": host}) for _ in range(2)]
            assert_safe(all("no-store" in h.get("cache-control", "") and "hit" not in h.get("cache-status", "")
                            for _, h, _ in responses), f"{host} does not store {path}")
        for path in ("/api", "/auth", "/account", "/checkout", "/api/cart"):
            _, headers, _ = request(edge, path, headers={"Host": host})
            assert_safe("cache-status" not in headers, f"sensitive route {path} bypasses cache entirely")
    for host, port in (("prod.edge.test", PORTS["production"]), ("store.test.dhimora.com", PORTS["preprod"])):
        _, _, body = request(port, "/__control/state")
        state = json.loads(body)
        assert_safe(any(key.startswith(host + " ") for key in state["renders"]), f"{host} reached the correct stub")
    # Prove the private proxy can actually invalidate, not just list, entries.
    request(edge, "/", headers={"Host": "purge.edge.test"})
    request(edge, "/", headers={"Host": "purge.edge.test"})
    status, _, _ = request(PORTS["purge"], "/__cache/souin/", "PURGE", {"Surrogate-Key": "store:purge.edge.test"})
    _, headers, _ = request(edge, "/", headers={"Host": "purge.edge.test"})
    assert_safe(status == 204 and "fwd=uri-miss" in headers.get("cache-status", ""), "private tag purge evicts the page")


def main():
    # Fail before starting anything if a fixed loopback port belongs to another local stack.
    for port in PORTS.values():
        with socket.socket() as sock:
            sock.bind(("127.0.0.1", port))
    name = "caddy-review-" + uuid.uuid4().hex[:10]
    processes, containers = [], []
    with tempfile.TemporaryDirectory(prefix="caddy-review-") as directory:
        directory = Path(directory)
        try:
            env_args = []
            for key, value in {
                "REDIS_HOST": f"127.0.0.1:{PORTS['redis']}",
                "REDIS_URL": f"127.0.0.1:{PORTS['redis']}",
                "UPSTREAM_URL": f"http://127.0.0.1:{PORTS['production']}",
                "UPSTREAM_HOST": f"127.0.0.1:{PORTS['production']}",
                "PREPROD_UPSTREAM_URL": f"http://127.0.0.1:{PORTS['preprod']}",
                "PREPROD_UPSTREAM_HOST": f"127.0.0.1:{PORTS['preprod']}",
            }.items():
                env_args.extend(["-e", f"{key}={value}"])
            adapted = run("docker", "run", "--rm", *env_args, "-v", f"{CADDYFILE}:/etc/caddy/Caddyfile:ro",
                          IMAGE, "caddy", "adapt", "--config", "/etc/caddy/Caddyfile", "--adapter", "caddyfile", capture_output=True)
            config = local_config(json.loads(adapted.stdout))
            (directory / "caddy.json").write_text(json.dumps(config))
            containers.append(name + "-redis")
            run("docker", "run", "-d", "--name", containers[-1], "--network", "host", "redis:8-alpine", "redis-server",
                "--bind", "127.0.0.1", "--port", str(PORTS["redis"]), "--save", "", "--appendonly", "no", capture_output=True)
            for label in ("production", "preprod"):
                log = (directory / f"{label}.log").open("w")
                process = subprocess.Popen(["node", str(ROOT / "scripts/stub-upstream.mjs")],
                                           env={**os.environ, "STUB_PORT": str(PORTS[label])}, stdout=log, stderr=log)
                log.close()
                processes.append(process)
                wait_ready(PORTS[label], "/__control/state")
            containers.append(name + "-edge")
            run("docker", "run", "-d", "--name", containers[-1], "--network", "host", "-v",
                f"{directory / 'caddy.json'}:/etc/caddy/test.json:ro", IMAGE, "caddy", "run", "--config", "/etc/caddy/test.json", capture_output=True)
            wait_ready(PORTS["edge"], "/health")
            # Existing branch suite now runs the actual production routes, not a divergent Caddyfile.local.
            for label, suffix in (("production", "edge.test"), ("preprod", "test.dhimora.com")):
                run("node", str(ROOT / "scripts/edge-check.mjs"), env={**os.environ,
                    "EDGE_TEST_HOST_SUFFIX": suffix,
                    "EDGE_URL": f"http://127.0.0.1:{PORTS['edge']}",
                    "EDGE_ADMIN_URL": f"http://127.0.0.1:{PORTS['admin']}",
                    "STUB_URL": f"http://127.0.0.1:{PORTS[label]}"})
            extra_checks()
            print("Production edge regression checks passed.", flush=True)
        except Exception:
            if len(containers) > 1:
                subprocess.run(["docker", "logs", "--tail", "35", containers[-1]], check=False)
            raise
        finally:
            for container in reversed(containers):
                subprocess.run(["docker", "rm", "-f", container], capture_output=True)
            for process in processes:
                process.terminate()
                process.wait(timeout=5)


if __name__ == "__main__":
    main()
