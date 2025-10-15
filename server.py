"""Lightweight HTTP bridge that connects the Node.js scraper with the Tailwind dashboard.

The server exposes a minimal REST API plus a Server-Sent-Events (SSE) stream so the
browser UI can start the scraper process and observe all log lines in real time –
without any external Python dependencies.
"""
from __future__ import annotations

import base64
import json
import mimetypes
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

PROGRESS_STATE: Dict[str, object] = {
    "total": 0,
    "completed": 0,
    "active": 0,
    "pending": 0,
    "percent": 0,
    "startedAt": None,
    "lastUpdated": None,
    "stage": "idle",
    "current": None,
    "lastCompleted": None,
    "message": None,
}
DOWNLOADED_FILES: Deque[Dict[str, object]] = deque(maxlen=300)
FILE_REGISTRY: Dict[str, str] = {}
PREVIEW_SIZE_LIMIT = int(os.environ.get("MCD_PREVIEW_LIMIT", str(8 * 1024 * 1024)))
TEXT_PREVIEW_MIMES = {
    "text/plain",
    "text/markdown",
    "text/csv",
    "application/json",
    "application/xml",
}

def current_timestamp() -> str:
    return datetime.now(timezone.utc).isoformat()


def reset_run_state() -> None:
    PROGRESS_STATE.update({
        "total": 0,
        "completed": 0,
        "active": 0,
        "pending": 0,
        "percent": 0,
        "startedAt": None,
        "lastUpdated": None,
        "stage": "idle",
        "current": None,
        "lastCompleted": None,
        "message": None,
    })
    DOWNLOADED_FILES.clear()
    FILE_REGISTRY.clear()


def format_size(num_bytes: int) -> str:
    if num_bytes <= 0:
        return "0 B"
    units = ["B", "KB", "MB", "GB", "TB"]
    value = float(num_bytes)
    index = 0
    while value >= 1024 and index < len(units) - 1:
        value /= 1024
        index += 1
    precision = 0 if value >= 10 or index == 0 else 1
    return f"{value:.{precision}f} {units[index]}"


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


def append_log(stream: str, message: str, **extra: object) -> Dict[str, object]:
    entry: Dict[str, object] = {
        "type": "log",
        "stream": stream,
        "message": message,
        "time": current_timestamp(),
    }
    if extra:
        entry.update(extra)
    LOG_HISTORY.append(entry)
    broadcast(entry)
    return entry


def update_progress_state(payload: Dict[str, object]) -> Dict[str, object]:
    total = int(payload.get("total") or 0)
    completed = int(payload.get("completed") or 0)
    active = int(payload.get("active") or 0)
    pending = int(payload.get("pending") or max(total - completed - active, 0))
    percent_raw = float(payload.get("percent") or (100 if total == 0 else (completed / total) * 100))
    percent = max(0.0, min(100.0, percent_raw))
    started_at = payload.get("startedAt") or PROGRESS_STATE.get("startedAt")
    PROGRESS_STATE.update({
        "total": total,
        "completed": completed,
        "active": active,
        "pending": pending,
        "percent": percent,
        "startedAt": started_at,
        "lastUpdated": current_timestamp(),
    })
    entry: Dict[str, object] = {
        "type": "progress",
        "time": PROGRESS_STATE["lastUpdated"],
        "total": total,
        "completed": completed,
        "active": active,
        "pending": pending,
        "percent": percent,
    }
    if started_at:
        entry["startedAt"] = started_at
    stage = payload.get("stage")
    if stage:
        entry["stage"] = stage
    PROGRESS_STATE["stage"] = stage
    for key in ("current", "lastCompleted", "message"):
        value = payload.get(key)
        PROGRESS_STATE[key] = value
        if value is not None:
            entry[key] = value
    broadcast(entry)
    return entry


def register_download(payload: Dict[str, object]) -> Optional[Dict[str, object]]:
    file_info = payload.get('file') if isinstance(payload, dict) else None
    if not isinstance(file_info, dict):
        return None
    file_path = file_info.get('path')
    if not file_path:
        return None
    file_id = base64.urlsafe_b64encode(file_path.encode('utf-8')).decode('ascii')
    FILE_REGISTRY[file_id] = file_path
    try:
        size_bytes = int(file_info.get('sizeBytes') or os.path.getsize(file_path))
    except OSError:
        size_bytes = int(file_info.get('sizeBytes') or 0)
    relative_path = file_info.get('relativePath') or os.path.relpath(file_path, ROOT_DIR)
    section_path = file_info.get('sectionPath') or ''
    relative_path = relative_path.replace(os.sep, '/')
    section_path = section_path.replace(os.sep, '/') if section_path else ''
    extension = (file_info.get('extension') or os.path.splitext(file_path)[1][1:]).lower() if file_path else ''
    mime = file_info.get('mime')
    if not mime:
        mime, _ = mimetypes.guess_type(file_path)
    if not mime and extension == 'md':
        mime = 'text/markdown'
    previewable = False
    if mime:
        previewable = mime.startswith('image/') or mime == 'application/pdf' or mime in TEXT_PREVIEW_MIMES
    elif extension:
        previewable = extension in {'pdf', 'txt', 'md', 'json', 'csv'}
    downloaded_at = file_info.get('downloadedAt') or current_timestamp()
    size_human = file_info.get('sizeHuman') or format_size(size_bytes)
    descriptor: Dict[str, object] = {
        'id': file_id,
        'name': file_info.get('name') or os.path.basename(file_path),
        'relativePath': relative_path,
        'sectionPath': section_path,
        'sizeBytes': size_bytes,
        'sizeHuman': size_human,
        'extension': extension,
        'mime': mime or 'application/octet-stream',
        'previewable': previewable,
        'resourceName': file_info.get('resourceName'),
        'url': file_info.get('url'),
        'downloadedAt': downloaded_at,
    }
    existing = {item.get('id'): idx for idx, item in enumerate(DOWNLOADED_FILES)}
    if file_id in existing:
        try:
            del DOWNLOADED_FILES[existing[file_id]]
        except IndexError:
            pass
    DOWNLOADED_FILES.appendleft(descriptor)
    entry = {'type': 'download', 'time': downloaded_at, 'file': descriptor}
    broadcast(entry)
    return entry


def handle_structured_message(data: Dict[str, object], stream: str) -> bool:
    if not isinstance(data, dict):
        return False
    message_type = data.get('type')
    if message_type == 'log':
        message = data.get('message')
        if message is None:
            return True
        level = str(data.get('level', 'info'))
        derived_stream = data.get('stream') or ('stderr' if level in {'warn', 'error'} else 'stdout')
        extra: Dict[str, object] = {}
        if 'level' in data:
            extra['level'] = level
        if 'context' in data:
            extra['context'] = data['context']
        if 'url' in data:
            extra['url'] = data['url']
        append_log(str(derived_stream), str(message), **extra)
        return True
    if message_type == 'progress':
        update_progress_state(data)
        return True
    if message_type == 'download':
        register_download(data)
        return True
    return False


def process_scraper_line(line: str, stream: str) -> bool:
    stripped = line.strip()
    if not stripped:
        return True
    try:
        payload = json.loads(stripped)
    except json.JSONDecodeError:
        return False
    return handle_structured_message(payload, stream)


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

    env = os.environ.copy()
    env.setdefault("MCD_LOG_FORMAT", "structured")
    env.setdefault("MCD_UI_LOG_LEVEL", env.get("MCD_UI_LOG_LEVEL", "info"))

    try:
        SCRAPER_PROCESS = subprocess.Popen(
            args,
            cwd=ROOT_DIR,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
            bufsize=1,
            env=env,
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
            if process_scraper_line(line, name):
                continue
            stripped = line.rstrip()
            if not stripped:
                continue
            print(f"[scraper:{name}] {stripped}", flush=True)
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
        reset_run_state()
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
        elif parsed.path == "/api/files/preview":
            self._handle_file_preview(parsed)
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
            "progress": dict(PROGRESS_STATE),
            "files": list(DOWNLOADED_FILES),
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
            self.wfile.write(format_sse({"type": "progress", **dict(PROGRESS_STATE)}))
            for file_entry in DOWNLOADED_FILES:
                self.wfile.write(format_sse({"type": "download", "file": file_entry}))
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

    def _handle_file_preview(self, parsed) -> None:
        params = parse_qs(parsed.query or '')
        file_ids = params.get('id')
        file_id = file_ids[0] if file_ids else None
        if not file_id:
            self.send_error(HTTPStatus.BAD_REQUEST, 'Missing file id')
            return
        file_path = FILE_REGISTRY.get(file_id)
        if not file_path or not os.path.exists(file_path):
            self.send_error(HTTPStatus.NOT_FOUND, 'Datei nicht gefunden')
            return
        try:
            size = os.path.getsize(file_path)
        except OSError as exc:
            self.send_error(HTTPStatus.INTERNAL_SERVER_ERROR, f'Datei konnte nicht gelesen werden: {exc}')
            return
        if size > PREVIEW_SIZE_LIMIT:
            self.send_error(HTTPStatus.REQUEST_ENTITY_TOO_LARGE, 'Datei zu groß für Vorschau')
            return
        mime, _ = mimetypes.guess_type(file_path)
        if not mime:
            mime = 'application/octet-stream'
        try:
            with open(file_path, 'rb') as fh:
                data = fh.read()
        except OSError as exc:
            self.send_error(HTTPStatus.INTERNAL_SERVER_ERROR, f'Datei konnte nicht gelesen werden: {exc}')
            return
        self.send_response(HTTPStatus.OK)
        self.send_header('Content-Type', mime)
        self.send_header('Content-Length', str(len(data)))
        self.send_header('Cache-Control', 'no-store')
        self.send_header('Content-Disposition', 'inline')
        self.end_headers()
        self.wfile.write(data)

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
