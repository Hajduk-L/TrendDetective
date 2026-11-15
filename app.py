"""HTTP server module exposing the Python topic, tool, and button interface to the web frontend.

This module serves static frontend assets, provides alphabetically sorted topics
from :func:`api_wrapper.get_all_topics_list` at ``GET /api/topics``, provides
available analysis tools from :mod:`src.task` at ``GET /api/tools``, and routes
button click events at ``POST /api/buttons/<button_id>`` to the single method
bound to that button; 'Apply' answers with its result in the same response and
the server keeps no state between requests. ``GET /api/places?q=<name>`` looks up
cities and regions; ``POST /api/coverage`` tells when the stations of a selection
have data; ``GET /api/examples`` lists famous events to start from (:mod:`examples`).
"""

from dataclasses import dataclass
from http.server import HTTPServer, SimpleHTTPRequestHandler, ThreadingHTTPServer
import importlib
import json
import math
from pathlib import Path
from typing import Any
from urllib.parse import parse_qs, unquote, urlsplit

import area_analysis
import examples
import station_coverage
import interface
import places
import plot_analysis

BASE_DIR: Path = Path(__file__).resolve().parent
INTERFACE_FILE: Path = BASE_DIR / "interface.py"
_LAST_MTIME: float = INTERFACE_FILE.stat().st_mtime
INTERFACE: interface.AppInterface = interface.AppInterface()


def get_interface() -> interface.AppInterface:
    """Return the active :class:`interface.AppInterface`, reloading if ``interface.py`` changed.

    :return: Active application interface instance.
    :rtype: interface.AppInterface
    """
    global _LAST_MTIME, INTERFACE
    current_mtime = INTERFACE_FILE.stat().st_mtime
    if current_mtime != _LAST_MTIME:
        importlib.reload(interface)
        INTERFACE = interface.AppInterface()
        _LAST_MTIME = current_mtime
    return INTERFACE


def new_request_interface() -> interface.AppInterface:
    """Return a fresh :class:`interface.AppInterface` for one 'Apply' request.

    The inputs and results of an 'Apply' live only in this object and travel
    back in the same HTTP response. Nothing is kept on the server between
    requests, so parallel users never share inputs or results, and it does not
    matter which server instance (e.g. on Vercel) answers a request.

    :return: New interface, after reloading ``interface.py`` if it changed.
    :rtype: interface.AppInterface
    """
    get_interface()  # reload interface.py if it changed
    return interface.AppInterface()


def _finite(value: Any) -> Any:
    """``value`` with NaN / infinity replaced by ``None`` (recursively)."""
    if isinstance(value, float):
        return value if math.isfinite(value) else None
    if isinstance(value, dict):
        return {key: _finite(item) for key, item in value.items()}
    if isinstance(value, (list, tuple)):
        return [_finite(item) for item in value]
    return value


def to_json(data: Any) -> str:
    """Strict JSON: Python writes NaN as ``NaN``, which browsers cannot parse."""
    try:
        return json.dumps(data, allow_nan=False)
    except ValueError:
        return json.dumps(_finite(data), allow_nan=False)


PUBLIC_FILES: frozenset[str] = frozenset({"/", "/index.html", "/favicon.ico"})
"""Files outside ``static/`` that the server delivers."""


def _is_public_path(path: str) -> bool:
    """Whether a GET path may be served from disk (the page and ``static/`` only)."""
    clean = unquote(path)
    if ".." in clean.split("/"):
        return False
    return clean in PUBLIC_FILES or clean.startswith("/static/")


@dataclass(frozen=True)
class ServerConfig:
    """Configuration parameters for the HTTP web server.

    :param host: Hostname or IP address to bind the server to.
    :type host: str
    :param port: TCP port number to listen on.
    :type port: int
    """

    host: str = "127.0.0.1"
    port: int = 8000


class WebAppHandler(SimpleHTTPRequestHandler):
    """HTTP request handler serving static files, topic/tool lists, and button API endpoints.

    :param request: Client socket request object.
    :type request: Any
    :param client_address: Client ``(host, port)`` tuple.
    :type client_address: tuple[str, int]
    :param server: Reference to the active :class:`HTTPServer` instance.
    :type server: HTTPServer
    """

    def __init__(
        self,
        request: Any,
        client_address: tuple[str, int],
        server: HTTPServer,
    ) -> None:
        """Initialize the request handler rooted at the project directory.

        :param request: Client socket request object.
        :type request: Any
        :param client_address: Client ``(host, port)`` tuple.
        :type client_address: tuple[str, int]
        :param server: Reference to the active :class:`HTTPServer` instance.
        :type server: HTTPServer
        :return: None
        :rtype: None
        """
        super().__init__(request, client_address, server, directory=str(BASE_DIR))

    def end_headers(self) -> None:
        """Append CORS and cache-control headers before finalizing HTTP headers.

        :return: None
        :rtype: None
        """
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type")
        self.send_header("Cache-Control", "no-store")
        super().end_headers()

    def do_OPTIONS(self) -> None:
        """Handle CORS preflight HTTP OPTIONS requests.

        :return: None
        :rtype: None
        """
        self.send_response(204)
        self.end_headers()

    def _send_json(self, status_code: int, data: Any) -> None:
        """Serialize ``data`` as JSON and write it to the HTTP response stream.

        :param status_code: HTTP status code to send.
        :type status_code: int
        :param data: JSON-serializable payload.
        :type data: Any
        :return: None
        :rtype: None
        """
        payload = to_json(data).encode("utf-8")
        self.send_response(status_code)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(payload)))
        self.end_headers()
        self.wfile.write(payload)

    def do_GET(self) -> None:
        """Handle HTTP GET requests for topics, tools, regions, places, or static files.

        :return: None
        :rtype: None
        """
        app_interface = get_interface()

        if self.path == "/api/topics":
            self._send_json(
                200,
                {
                    "topics": app_interface.get_sorted_topics(),
                    # Readable names, groups and sources for the topic list.
                    "details": interface.api_wrapper.get_topic_details(),
                },
            )
            return

        url = urlsplit(self.path)
        if url.path == "/api/places":
            query = parse_qs(url.query).get("q", [""])[0]
            try:
                self._send_json(200, {"places": places.search_places(query)})
            except ValueError as exc:
                self._send_json(400, {"error": str(exc)})
            except RuntimeError as exc:
                self._send_json(502, {"error": str(exc)})
            return

        if url.path == "/api/regions":
            # ``?topics=a,b``: only regions where a selected topic can be evaluated.
            topics = [t for t in parse_qs(url.query).get("topics", [""])[0].split(",") if t]
            self._send_json(200, {"regions": area_analysis.list_regions(topics)})
            return

        if url.path == "/api/examples":
            self._send_json(200, {"examples": examples.list_examples()})
            return

        if self.path == "/api/tools":
            self._send_json(200, {"tools": app_interface.get_sorted_tools()})
            return

        if self.path == "/api/buttons":
            self._send_json(200, app_interface.get_buttons_metadata())
            return

        if not _is_public_path(url.path):
            # Only the page and static/ are served: never source code, .git, .venv or data/.
            self.send_error(404, "File not found")
            return
        super().do_GET()

    def _handle_analyze(self) -> None:
        """Run analysis tools on a series sent by the plot panel (``POST /api/analyze``).

        Expects ``{"x": [...], "values": [...], "tools": [...]}`` and answers
        with :func:`plot_analysis.analyze_series`, or ``{"groups": [{"key",
        "x", "values"}, ...], "tools": [...]}`` (one series per year) and
        answers with :func:`plot_analysis.analyze_groups`.

        :return: None
        :rtype: None
        """
        try:
            length = int(self.headers.get("Content-Length", 0))
            body = json.loads(self.rfile.read(length).decode("utf-8") or "{}")
            if not isinstance(body, dict):
                raise plot_analysis.AnalysisError("Body must be a JSON object.")
            if "groups" in body:
                result = plot_analysis.analyze_groups(body["groups"], body.get("tools"))
            else:
                season = body.get("season_length")
                result = plot_analysis.analyze_series(
                    body.get("x", []),
                    body.get("values", []),
                    body.get("tools"),
                    float(season) if isinstance(season, (int, float)) and not isinstance(season, bool) else None,
                )
        except (json.JSONDecodeError, ValueError) as exc:
            self._send_json(400, {"error": str(exc)})
            return
        self._send_json(200, result)

    def _handle_coverage(self) -> None:
        """Answer when a result card's topic has data (``POST /api/coverage``).

        Expects ``{"area": <map selection>, "topic": <card key>,
        "timeintervall": [DD.MM.YYYY, DD.MM.YYYY]}`` and answers with
        :func:`station_coverage.data_coverage`.

        :return: None
        :rtype: None
        """
        try:
            length = int(self.headers.get("Content-Length", 0))
            body = json.loads(self.rfile.read(length).decode("utf-8") or "{}")
            if not isinstance(body, dict):
                raise station_coverage.CoverageError("Body must be a JSON object.")
            result = station_coverage.data_coverage(
                body.get("area"), str(body.get("topic", "")), body.get("timeintervall")
            )
        except (json.JSONDecodeError, ValueError) as exc:
            self._send_json(400, {"error": str(exc)})
            return
        except RuntimeError as exc:  # NOAA unreachable or failing
            self._send_json(502, {"error": str(exc)})
            return
        self._send_json(200, result)

    def _stream_apply(self, app_interface: interface.AppInterface) -> None:
        """Answer 'Apply' progressively (``POST /api/buttons/apply/stream``).

        Same body as ``/api/buttons/apply``. The response is NDJSON, one object
        per line, written as soon as it is ready: ``{"type": "request",
        "user_request", "topics"}``, then ``{"type": "partial", "topic", "done",
        "total", "visualization"}`` after each topic (the result of the topics
        finished so far), then ``{"type": "done", "visualization"}`` with the
        full result.
        An unexpected failure ends the stream with ``{"type": "error", "error"}``.
        The server speaks HTTP/1.0, so the body simply ends when the connection closes.

        :param app_interface: Interface already holding this request's inputs.
        :type app_interface: interface.AppInterface
        :return: None
        :rtype: None
        """
        try:
            user_request = app_interface.prepare_apply()
        except (ValueError, AssertionError) as exc:
            self._send_json(400, {"error": str(exc)})
            return
        topics = [name for name, checked in user_request.topics.items() if checked]

        def write(message: dict[str, Any]) -> None:
            self.wfile.write(to_json(message).encode("utf-8") + b"\n")
            self.wfile.flush()

        self.send_response(200)
        self.send_header("Content-Type", "application/x-ndjson; charset=utf-8")
        self.end_headers()
        try:
            write({"type": "request", "user_request": user_request.to_dict(), "topics": topics})
            for done, (topic, visualization) in enumerate(app_interface.iter_apply(user_request), 1):
                write({
                    "type": "partial",
                    "topic": topic,
                    "done": done,
                    "total": len(topics),
                    "visualization": visualization,
                })
            write({"type": "done", "visualization": app_interface.last_task_results})
        except (BrokenPipeError, ConnectionResetError):
            return  # the page went away or started a new request
        except Exception as exc:  # noqa: BLE001 - tell the page; the parts shown stay
            try:
                write({"type": "error", "error": f"{type(exc).__name__}: {exc}"})
            except OSError:
                pass
        self.close_connection = True

    def do_POST(self) -> None:
        """Handle HTTP POST requests to trigger a specific button's bound method.

        Expects paths matching ``/api/buttons/<button_id>``. Updates the topic
        selection, tool selection, ``timeintervall`` brackets (in ``DD.MM.YYYY``
        format), interval length tuple, and map area from the JSON body before
        invoking the button trigger.

        :return: None
        :rtype: None
        """
        if self.path == "/api/analyze":
            self._handle_analyze()
            return

        if self.path == "/api/coverage":
            self._handle_coverage()
            return

        # A fresh interface per request: inputs and results are never shared
        # between requests (see new_request_interface).
        app_interface = new_request_interface()
        prefix = "/api/buttons/"
        if self.path.startswith(prefix):
            button_id = unquote(self.path[len(prefix) :]).strip("/")

            content_length = int(self.headers.get("Content-Length", 0))
            if content_length > 0:
                raw_body = self.rfile.read(content_length).decode("utf-8")
                try:
                    body = json.loads(raw_body)
                    if isinstance(body, dict):
                        topics = (
                            body.get("topics")
                            if isinstance(body.get("topics"), dict)
                            else {}
                        )
                        tools = (
                            body.get("tools")
                            if isinstance(body.get("tools"), dict)
                            else {}
                        )
                        raw_ti = body.get(
                            "timeintervall",
                            body.get("timestamp", ["", ""]),
                        )
                        if isinstance(raw_ti, list) and len(raw_ti) == 2:
                            timeintervall = (str(raw_ti[0]), str(raw_ti[1]))
                        else:
                            raise ValueError(
                                "timeintervall must be a pair of DD.MM.YYYY strings."
                            )

                        raw_interval = body.get("interval_length", [1.0, "Day"])
                        if isinstance(raw_interval, list) and len(raw_interval) == 2:
                            interval_length = (
                                float(raw_interval[0]),
                                str(raw_interval[1]),
                            )
                        else:
                            raise ValueError(
                                "interval_length must be a [float, str] pair."
                            )

                        raw_area = body.get("area")
                        area = raw_area if isinstance(raw_area, dict) else None

                        app_interface.set_request_inputs(
                            states=topics,
                            tools=tools,
                            timeintervall=timeintervall,
                            interval_length=interval_length,
                            area=area,
                        )
                except (json.JSONDecodeError, ValueError, TypeError, AssertionError) as exc:
                    self._send_json(400, {"error": str(exc)})
                    return

            if button_id == "apply/stream":
                self._stream_apply(app_interface)
                return

            try:
                app_interface.trigger_button(button_id)
            except KeyError:
                self.send_error(404, f"Button '{button_id}' not found")
                return
            except (ValueError, AssertionError) as exc:
                self._send_json(400, {"error": str(exc)})
                return

            # The result goes back in this response; the server keeps nothing.
            self._send_json(
                200,
                {
                    "user_request": (
                        app_interface.last_user_request.to_dict()
                        if app_interface.last_user_request is not None
                        else None
                    ),
                    "visualization": app_interface.last_task_results,
                },
            )
            return

        self.send_error(404, "Endpoint not found")


def run(config: ServerConfig = ServerConfig()) -> None:
    """Start the threaded HTTP server using the provided server configuration.

    :param config: Server host and port configuration.
    :type config: ServerConfig
    :return: None
    :rtype: None
    """
    server = ThreadingHTTPServer((config.host, config.port), WebAppHandler)
    print(f"Server running at http://{config.host}:{config.port}")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\nShutting down server...")
    finally:
        server.server_close()


if __name__ == "__main__":
    run()
