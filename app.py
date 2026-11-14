"""HTTP server module exposing the Python topic and button interface to the web frontend.

This module serves static frontend assets, provides alphabetically sorted topics
from ``marten.getTopics()`` at ``GET /api/topics``, and routes button click events
at ``POST /api/buttons/<button_id>`` to the single method bound to that button.
"""

from dataclasses import dataclass
from http.server import HTTPServer, SimpleHTTPRequestHandler, ThreadingHTTPServer
import importlib
import json
from pathlib import Path
from typing import Any
from urllib.parse import unquote

import interface

BASE_DIR: Path = Path(__file__).resolve().parent
INTERFACE_FILE: Path = BASE_DIR / "interface.py"
_LAST_MTIME: float = INTERFACE_FILE.stat().st_mtime
INTERFACE: interface.AppInterface = interface.AppInterface()


def get_interface() -> interface.AppInterface:
    """Return the active :class:`interface.AppInterface`, reloading if ``interface.py`` changed.

    This ensures any changes to :meth:`interface.marten.getTopics` on disk are
    reflected immediately without manually restarting the server.

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
    """HTTP request handler serving static files, topic lists, and button API endpoints.

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
        payload = json.dumps(data).encode("utf-8")
        self.send_response(status_code)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(payload)))
        self.end_headers()
        self.wfile.write(payload)

    def do_GET(self) -> None:
        """Handle HTTP GET requests for topics, button metadata, or static files.

        :return: None
        :rtype: None
        """
        app_interface = get_interface()

        if self.path == "/api/topics":
            self._send_json(200, {"topics": app_interface.get_sorted_topics()})
            return

        if self.path == "/api/buttons":
            self._send_json(200, app_interface.get_buttons_metadata())
            return

        if self.path == "/api/user-request":
            user_request_data = (
                app_interface.last_user_request.to_dict()
                if app_interface.last_user_request is not None
                else None
            )
            self._send_json(200, {"user_request": user_request_data})
            return

        super().do_GET()

    def do_POST(self) -> None:
        """Handle HTTP POST requests to trigger a specific button's bound method.

        Expects paths matching ``/api/buttons/<button_id>``. Updates the topic
        selection, timestamp brackets, interval length tuple, and map area
        (GeoJSON Feature or ``null``) from the JSON body before invoking the
        button trigger.

        :return: None
        :rtype: None
        """
        app_interface = get_interface()
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
                        raw_ts = body.get("timestamp", ["", ""])
                        if isinstance(raw_ts, list) and len(raw_ts) == 2:
                            timestamp = (str(raw_ts[0]), str(raw_ts[1]))
                        else:
                            timestamp = ("", "")

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
                            timestamp=timestamp,
                            interval_length=interval_length,
                            area=area,
                        )
                except (json.JSONDecodeError, ValueError, TypeError, AssertionError) as exc:
                    self.send_error(400, str(exc))
                    return

            try:
                app_interface.trigger_button(button_id)
            except KeyError:
                self.send_error(404, f"Button '{button_id}' not found")
                return
            except (ValueError, AssertionError) as exc:
                self.send_error(400, str(exc))
                return

            self.send_response(204)
            self.end_headers()
            return

        self.send_error(404, "Endpoint not found")


def run(config: ServerConfig = ServerConfig()) -> None:
    """Start the HTTP server using the provided server configuration.

    :param config: Server host and port configuration.
    :type config: ServerConfig
    :return: None
    :rtype: None
    """
    # Threaded: the map widget loads several files in parallel (e.g. its web workers), and
    # browsers keep idle pre-opened connections that would block a single-threaded server.
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
