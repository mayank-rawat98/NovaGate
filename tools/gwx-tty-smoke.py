"""Real POSIX terminal regression for hidden login input and cancelled apply.

Requires Python 3 on macOS/Linux for verification only; gwx has no Python dependency.
Uses disposable fixture credentials and a loopback HTTP server, never user sessions.
"""
import json
import os
import pty
import select
import shutil
import subprocess
import tempfile
import threading
import time
import uuid
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

fixture_tenant = str(uuid.uuid4())
fixture_password = "pty-fixture-password-never-echo"
fixture_token = "pty-fixture-session-never-echo"
requests = []


class Handler(BaseHTTPRequestHandler):
    def log_message(self, *_args):
        pass

    def do_POST(self):
        body = self.rfile.read(int(self.headers.get("Content-Length", "0"))).decode()
        requests.append((self.path, body))
        if self.path == "/api/auth/login":
            assert json.loads(body) == {
                "email": "pty@example.test", "password": fixture_password
            }
            value = {"token": fixture_token, "tenantId": fixture_tenant}
        elif self.path.endswith("dryRun=true"):
            value = {
                "dryRun": True, "revision": "1791999999." + "a" * 64,
                "expiresAt": "2026-10-12T00:00:00Z", "configVersion": 1,
                "unchanged": 0, "changes": [],
            }
        else:
            raise AssertionError("Cancelled apply reached a mutation")
        payload = json.dumps(value).encode()
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(payload)))
        self.end_headers()
        self.wfile.write(payload)


def main():
    server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    server_thread = threading.Thread(target=server.serve_forever, daemon=True)
    server_thread.start()
    entry = Path(__file__).resolve().parents[1] / "tools/gwx/dist/main.js"
    node = shutil.which("node")
    if not node:
        raise RuntimeError("Node.js is required for gwx terminal verification")
    try:
        with tempfile.TemporaryDirectory(prefix="gwx-pty-") as directory:
            env = {
                "PATH": os.environ["PATH"], "GWX_CONFIG_DIR": directory + "/credentials",
                "GW_API_URL": f"http://127.0.0.1:{server.server_port}/api",
            }

            def run(args, prompt, answer, expected_code=0, raw=False):
                master, slave = pty.openpty()
                child = subprocess.Popen(
                    [node, str(entry), *args], stdin=slave, stdout=slave, stderr=slave,
                    cwd=directory, env=env,
                )
                os.close(slave)
                output = b""
                sent = False
                deadline = time.monotonic() + 8
                try:
                    while time.monotonic() < deadline:
                        if select.select([master], [], [], 0.1)[0]:
                            try:
                                part = os.read(master, 65536)
                            except OSError:
                                break
                            if not part:
                                break
                            output += part
                            if len(output) > 65536:
                                raise RuntimeError("Unbounded terminal output")
                            if not sent and prompt.encode() in output:
                                # Reply immediately: do not hide the original prompt/raw-input race.
                                os.write(master, (answer if raw else answer + "\n").encode())
                                sent = True
                    assert sent and child.wait(timeout=2) == expected_code
                    return output.decode(errors="replace")
                finally:
                    if child.poll() is None:
                        child.kill()
                        child.wait()
                    os.close(master)

            output = run(["login", "--email", "pty@example.test"], "Password: ", fixture_password)
            assert fixture_password not in output and fixture_token not in output
            path = Path(directory) / "gateway.yml"
            path.write_text("version: 1\nservices: []\nroutes: []\nconsumers: []\n")
            cancelled = run(["routes", "apply", str(path)], "Apply these reviewed changes? [y/N] ", "n")
            assert "Cancelled." in cancelled
            assert len(requests) == 2 and requests[1][0].endswith("dryRun=true")
            interrupted = run(["login", "--email", "pty@example.test"], "Password: ", "\x03", 130, True)
            assert "Interrupted." in interrupted
            closed = run(["routes", "apply", str(path)], "Apply these reviewed changes? [y/N] ", "\x04", 2, True)
            assert "Input closed" in closed
            assert len(requests) == 3 and requests[-1][0].endswith("dryRun=true")
            print(json.dumps({
                "realPseudoTerminal": True, "hiddenPasswordNoEcho": True,
                "interactiveApplyCancelWithoutMutation": True,
                "terminalCtrlCExits130": True, "terminalEofWithoutMutation": True,
            }))
    finally:
        server.shutdown()
        server.server_close()
        server_thread.join(timeout=2)


if __name__ == "__main__":
    main()
