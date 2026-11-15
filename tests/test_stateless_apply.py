"""'Apply' answers with its own result and keeps no state between requests.

On Vercel the requests of one user can reach different server instances, and
several users share an instance, so nothing of an 'Apply' may live on the server.
"""

import json
import threading
import time
import unittest
from http.server import ThreadingHTTPServer
from unittest import mock
from urllib.error import HTTPError
from urllib.request import Request, urlopen

import app
import interface
import src.task as task

TOPICS = ["precipitation", "temperature"]


def _records(topic: str, *_args) -> list[dict]:
    if topic == "temperature":
        time.sleep(0.3)  # slow, so the other request runs while this one waits
    code = "TMAX" if topic == "temperature" else "PRCP"
    return [
        {
            "date": f"2020-01-{d:02d}",
            "value": float(d),
            "description": code,
            "unit": "°C",
            "station": "S1",
            "station_name": "Station S1",
            "latitude": 48.1,
            "longitude": 11.5,
            "elevation": 500,
            "source": "test",
        }
        for d in range(1, 9)
    ]


def _body(topic: str) -> bytes:
    return json.dumps({
        "topics": {t: t == topic for t in TOPICS},
        "tools": {"Linear Regression": True},
        "timeintervall": ["01.01.2020", "08.01.2020"],
        "interval_length": [1, "Day"],
        "area": None,
    }).encode()


class StatelessApplyTest(unittest.TestCase):
    def setUp(self) -> None:
        patches = [
            mock.patch.object(task, "_load_records_for_topic", side_effect=_records),
            mock.patch.object(interface.AppInterface, "get_sorted_topics", lambda self: list(TOPICS)),
        ]
        for p in patches:
            p.start()
            self.addCleanup(p.stop)
        self.server = ThreadingHTTPServer(("127.0.0.1", 0), app.WebAppHandler)
        threading.Thread(target=self.server.serve_forever, daemon=True).start()
        self.addCleanup(self.server.server_close)
        self.addCleanup(self.server.shutdown)
        self.base = f"http://127.0.0.1:{self.server.server_address[1]}"

    def _post(self, path: str, topic: str) -> bytes:
        req = Request(self.base + path, data=_body(topic), headers={"Content-Type": "application/json"})
        with urlopen(req, timeout=10) as res:
            return res.read()

    def test_apply_returns_its_result(self) -> None:
        data = json.loads(self._post("/api/buttons/apply", "precipitation"))
        self.assertEqual(data["user_request"]["topics"], {"precipitation": True, "temperature": False})
        self.assertTrue(all(k.startswith("precipitation") for k in data["visualization"]["topics"]))

    def test_parallel_requests_get_their_own_results(self) -> None:
        results: dict[str, list[str]] = {}

        def run(topic: str) -> None:
            lines = self._post("/api/buttons/apply/stream", topic).decode().splitlines()
            done = [json.loads(l) for l in lines if json.loads(l)["type"] == "done"][0]
            results[topic] = list(done["visualization"]["topics"])

        slow = threading.Thread(target=run, args=("temperature",))
        slow.start()
        time.sleep(0.1)  # the slow request has set its inputs and is fetching
        run("precipitation")
        slow.join()
        self.assertTrue(results["temperature"])
        self.assertTrue(all(k.startswith("temperature") for k in results["temperature"]))
        self.assertTrue(all(k.startswith("precipitation") for k in results["precipitation"]))

    def test_no_stored_result_endpoint(self) -> None:
        with self.assertRaises(HTTPError) as ctx:
            urlopen(self.base + "/api/user-request", timeout=10)
        self.assertEqual(ctx.exception.code, 404)


if __name__ == "__main__":
    unittest.main()
