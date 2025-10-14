"""Lightweight HTTP bridge that connects the Node.js scraper with the Tailwind dashboard.

The server exposes a minimal REST API plus a Server-Sent-Events (SSE) stream so the
browser UI can start the scraper process and observe all log lines in real time –
without any external Python dependencies.
"""
from __future__ import annotations

import json
import os
import queue
import subprocess
import threading
import time
from collections import deque
from datetime import datetime, timezone
from http import HTTPStatus
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from typing import Deque, Dict, List, Optional, Tuple
from urllib.parse import parse_qs, urlparse

ROOT_DIR = os.path.dirname(os.path.abspath(__file__))
SCRAPER_PATH = os.path.join(ROOT_DIR, "scraper.js")
DEFAULT_COURSES_FILE = os.environ.get("COURSES_FILE")
WEBUI_INDEX = os.path.join(ROOT_DIR, "webui", "index.html")

LOG_HISTORY: Deque[Dict[str, str]] = deque(maxlen=500)
STATE: Dict[str, Optional[str]] = {"status": "idle"}
CLIENTS: List["StreamClient"] = []
CLIENTS_LOCK = threading.Lock()
SCRAPER_LOCK = threading.Lock()
SCRAPER_THREAD: Optional[threading.Thread] = None
SCRAPER_PROCESS: Optional[subprocess.Popen] = None
COURSES_CACHE: Tuple[float, List[Dict[str, object]]] = (0.0, [])


def current_timestamp() -> str:
    return datetime.now(timezone.utc).isoformat()


class StreamClient:
    """Represents one active SSE connection."""

    def __init__(self) -> None:
        self.queue: "queue.Queue[Dict[str, object]]" = queue.Queue(maxsize=500)
        self.alive = True

    def push(self, message: Dict[str, object]) -> None:
        if not self.alive:
            return
        try:
            self.queue.put_nowait(message)
        except queue.Full:
            # Drop oldest entry to make room for new message
            try:
                self.queue.get_nowait()
            except queue.Empty:
                pass
            try:
                self.queue.put_nowait(message)
            except queue.Full:
                pass


def broadcast(message: Dict[str, object]) -> None:
    """Send a message to every connected SSE client."""

    with CLIENTS_LOCK:
        for client in list(CLIENTS):
            client.push(message)


def append_log(stream: str, message: str) -> Dict[str, object]:
    entry: Dict[str, object] = {
        "type": "log",
        "stream": stream,
        "message": message,
        "time": current_timestamp(),
    }
    LOG_HISTORY.append(entry)
    broadcast(entry)
    return entry


def set_status(status: str, **details: object) -> None:
    STATE["status"] = status
    payload: Dict[str, object] = {"type": "status", "status": status}
    if details:
        payload.update(details)
    broadcast(payload)


def _normalize_courses(raw_courses: List[Dict[str, object]]) -> List[Dict[str, object]]:
    normalized: List[Dict[str, object]] = []
    for item in raw_courses:
        if not isinstance(item, dict):
            continue
        course_id = item.get("courseId") or item.get("id") or item.get("course_id") or ""
        normalized.append(
            {
                "id": str(course_id) if course_id is not None else "",
                "title": item.get("title") or item.get("name") or "Unbenannter Kurs",
                "url": item.get("url"),
                "description": item.get("description")
                or item.get("summary")
                or item.get("shortname"),
            }
        )
    return normalized


def _load_courses_from_scraper(force: bool = False) -> List[Dict[str, object]]:
    global COURSES_CACHE
    cache_time, cached_courses = COURSES_CACHE
    now = time.time()
    if cached_courses and not force and now - cache_time < 300:
        return cached_courses

    env = os.environ.copy()
    env.setdefault("MCD_SILENT_LOGS", "1")

    timeout = int(env.get("MCD_COURSE_TIMEOUT", "120"))
    try:
        result = subprocess.run(
            ["node", SCRAPER_PATH, "--listCourses"],
            cwd=ROOT_DIR,
            capture_output=True,
            text=True,
            timeout=timeout,
            env=env,
        )
    except subprocess.TimeoutExpired:
        append_log("stderr", "Kursliste konnte nicht geladen werden: Zeitüberschreitung")
        return cached_courses
    except OSError as exc:
        append_log("stderr", f"Kursliste konnte nicht geladen werden: {exc}")
        return cached_courses

    stdout = (result.stdout or "").strip()
    stderr = (result.stderr or "").strip()
    if result.returncode != 0:
        message = stdout or stderr
        if message:
            append_log("stderr", f"Kursliste fehlgeschlagen ({result.returncode}): {message}")
        else:
            append_log("stderr", f"Kursliste fehlgeschlagen mit Code {result.returncode}")
        return cached_courses

    if not stdout:
        append_log("stderr", "Kursliste lieferte keine Daten")
        return cached_courses

    try:
        payload = json.loads(stdout)
    except json.JSONDecodeError as exc:
        append_log("stderr", f"Antwort der Kursliste ist ungültig: {exc}")
        return cached_courses

    if isinstance(payload, dict):
        raw_courses = payload.get("courses")
        if not isinstance(raw_courses, list):
            append_log("stderr", "Antwort der Kursliste enthielt keine Kursliste")
            return cached_courses
    elif isinstance(payload, list):
        raw_courses = payload
    else:
        append_log("stderr", "Antwort der Kursliste hatte ein unbekanntes Format")
        return cached_courses

    normalized = _normalize_courses(raw_courses)
    COURSES_CACHE = (now, normalized)
    return normalized


def _load_courses(force: bool = False) -> List[Dict[str, object]]:
    courses = _load_courses_from_scraper(force=force)
    if courses:
        return courses

    if DEFAULT_COURSES_FILE and os.path.exists(DEFAULT_COURSES_FILE):
        try:
            with open(DEFAULT_COURSES_FILE, "r", encoding="utf-8") as fh:
                data = json.load(fh)
            if isinstance(data, list):
                return _normalize_courses(data)
        except (json.JSONDecodeError, OSError) as exc:
            append_log("stderr", f"Kurse konnten nicht geladen werden: {exc}")

    env_course = os.environ.get("COURSE_URL")
    if env_course:
        return [
            {
                "id": "default",
                "title": "Standardkurs",
                "url": env_course,
                "description": "Kurs aus der COURSE_URL-Umgebungsvariable",
            }
        ]

    return []


def scraper_running() -> bool:
    thread = SCRAPER_THREAD
    return bool(thread and thread.is_alive())


def payload_to_args(payload: Dict[str, object]) -> List[str]:
    args: List[str] = []
    if output_dir := payload.get("outputDir"):
        args.extend(["--outputDir", str(output_dir)])
    if download_mode := payload.get("downloadMode"):
        args.extend(["--downloadMode", str(download_mode)])
    if max_concurrent := payload.get("maxConcurrentDownloads"):
        args.extend(["--maxConcurrentDownloads", str(max_concurrent)])
    for flag in ("keepBrowserOpen", "enableNotifications", "manualDownload"):
        if payload.get(flag):
            args.append(f"--{flag}")
    if course_url := payload.get("courseUrl"):
        args.extend(["--courseUrl", str(course_url)])
    return args


def run_scraper(payload: Dict[str, object]) -> None:
    global SCRAPER_PROCESS, SCRAPER_THREAD
    set_status("starting", args=payload_to_args(payload))
    args = ["node", SCRAPER_PATH] + payload_to_args(payload)

    try:
        SCRAPER_PROCESS = subprocess.Popen(
            args,
            cwd=ROOT_DIR,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
            bufsize=1,
        )
    except FileNotFoundError as exc:
        append_log("stderr", f"Node runtime not found: {exc}")
        set_status("error", reason="node-not-found")
        SCRAPER_PROCESS = None
        SCRAPER_THREAD = None
        return
    except Exception as exc:  # pragma: no cover
        append_log("stderr", f"Failed to start scraper: {exc}")
        set_status("error", reason="spawn-failed")
        SCRAPER_PROCESS = None
        SCRAPER_THREAD = None
        return

    set_status("running", pid=SCRAPER_PROCESS.pid)

    def pump(stream, name: str) -> None:
        if not stream:
            return
        for line in iter(stream.readline, ""):
            append_log(name, line.rstrip())
        stream.close()

    stdout_thread = threading.Thread(target=pump, args=(SCRAPER_PROCESS.stdout, "stdout"), daemon=True)
    stderr_thread = threading.Thread(target=pump, args=(SCRAPER_PROCESS.stderr, "stderr"), daemon=True)
    stdout_thread.start()
    stderr_thread.start()

    SCRAPER_PROCESS.wait()
    stdout_thread.join(timeout=1)
    stderr_thread.join(timeout=1)

    code = SCRAPER_PROCESS.returncode
    set_status("finished", code=code)
    SCRAPER_PROCESS = None
    SCRAPER_THREAD = None


def start_scraper(payload: Dict[str, object]) -> Tuple[bool, Optional[str]]:
    global SCRAPER_THREAD
    with SCRAPER_LOCK:
        if scraper_running():
            return False, "Scraper is already running"
        SCRAPER_THREAD = threading.Thread(target=run_scraper, args=(payload,), daemon=True)
        SCRAPER_THREAD.start()
        return True, None


def format_sse(message: Dict[str, object]) -> bytes:
    data = json.dumps(message, ensure_ascii=False)
    event = message.get("type", "message")
    return f"event: {event}\ndata: {data}\n\n".encode("utf-8")


class RequestHandler(BaseHTTPRequestHandler):
    server_version = "MoodleCourseDownloader/1.0"
    sys_version = ""

    def end_headers(self) -> None:  # type: ignore[override]
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "GET,POST,OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type")
        super().end_headers()

    def do_OPTIONS(self) -> None:  # noqa: N802 (method required by BaseHTTPRequestHandler)
        self.send_response(HTTPStatus.NO_CONTENT)
        self.end_headers()

    def do_GET(self) -> None:  # noqa: N802
        parsed = urlparse(self.path)
        if parsed.path in {"/", "/index.html"}:
            self._handle_root()
        elif parsed.path == "/api/status":
            self._handle_status()
        elif parsed.path == "/api/courses":
            params = parse_qs(parsed.query or "")
            force = "refresh" in params or params.get("force") == ["1"]
            self._handle_courses(force=force)
        elif parsed.path == "/api/stream":
            self._handle_stream()
        else:
            self.send_error(HTTPStatus.NOT_FOUND, "Unknown endpoint")

    def do_POST(self) -> None:  # noqa: N802
        parsed = urlparse(self.path)
        if parsed.path == "/api/run":
            self._handle_run()
        else:
            self.send_error(HTTPStatus.NOT_FOUND, "Unknown endpoint")

    # Handlers -----------------------------------------------------------------

    def _handle_status(self) -> None:
        payload = {
            "running": scraper_running(),
            "status": STATE.get("status", "idle"),
            "log": list(LOG_HISTORY),
        }
        self._send_json(payload)

    def _handle_courses(self, force: bool = False) -> None:
        payload = {"courses": _load_courses(force=force)}
        self._send_json(payload)

    def _handle_root(self) -> None:
        if not os.path.exists(WEBUI_INDEX):
            self.send_error(HTTPStatus.NOT_FOUND, "Dashboard nicht gefunden")
            return
        try:
            with open(WEBUI_INDEX, "rb") as fh:
                body = fh.read()
        except OSError as exc:
            self.send_error(HTTPStatus.INTERNAL_SERVER_ERROR, f"Datei konnte nicht gelesen werden: {exc}")
            return
        self.send_response(HTTPStatus.OK)
        self.send_header("Content-Type", "text/html; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _handle_run(self) -> None:
        length = int(self.headers.get("Content-Length", "0"))
        body = self.rfile.read(length) if length else b"{}"
        try:
            payload = json.loads(body or b"{}")
        except json.JSONDecodeError:
            self.send_error(HTTPStatus.BAD_REQUEST, "Invalid JSON")
            return

        success, error = start_scraper(payload if isinstance(payload, dict) else {})
        if not success:
            self.send_error(HTTPStatus.CONFLICT, error or "Scraper busy")
            return
        self._send_json({"status": "scheduled"})

    def _handle_stream(self) -> None:
        client = StreamClient()
        with CLIENTS_LOCK:
            CLIENTS.append(client)
        try:
            self.send_response(HTTPStatus.OK)
            self.send_header("Content-Type", "text/event-stream")
            self.send_header("Cache-Control", "no-cache")
            self.send_header("Connection", "keep-alive")
            self.end_headers()

            # Send initial snapshot
            for entry in LOG_HISTORY:
                self.wfile.write(format_sse(entry))
            self.wfile.write(format_sse({"type": "status", "status": STATE.get("status", "idle")}))
            self.wfile.flush()

            while client.alive:
                try:
                    message = client.queue.get(timeout=10)
                except queue.Empty:
                    self.wfile.write(b": keepalive\n\n")
                    self.wfile.flush()
                    continue
                self.wfile.write(format_sse(message))
                self.wfile.flush()
        except (ConnectionResetError, BrokenPipeError):
            pass
        finally:
            client.alive = False
            with CLIENTS_LOCK:
                if client in CLIENTS:
                    CLIENTS.remove(client)

    # Helpers ------------------------------------------------------------------

    def _send_json(self, payload: Dict[str, object], status: HTTPStatus = HTTPStatus.OK) -> None:
        body = json.dumps(payload).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, format: str, *args) -> None:  # noqa: A003
        # Silence default console logging to avoid polluting stdout.
        return


def serve(host: str = "0.0.0.0", port: int = 8000) -> None:
    httpd = ThreadingHTTPServer((host, port), RequestHandler)
    append_log("stdout", f"Python bridge listening on http://{host}:{port}")
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        httpd.server_close()
        append_log("stdout", "Server stopped")
        process = SCRAPER_PROCESS
        if process and process.poll() is None:
            process.terminate()
            try:
                process.wait(timeout=5)
            except subprocess.TimeoutExpired:
                process.kill()


if __name__ == "__main__":
    host = os.environ.get("MCD_API_HOST", "0.0.0.0")
    port = int(os.environ.get("MCD_API_PORT", "8000"))
    serve(host=host, port=port)
