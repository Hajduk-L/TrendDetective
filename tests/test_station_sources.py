"""Tests for the additional data sources and the duplicate matching (offline)."""

import tempfile
import unittest
from datetime import date
from pathlib import Path
from unittest import mock

import api_wrapper
import area_analysis
import dwd_api
import fmi_api
import station_sources
from polarwatch_api import polar_stereographic
from station_sources import Station


def station(source: str, id_: str, lat: float, lon: float, ids=(), coverage=1.0, priority=0, elevation=None):
    return Station(
        source=source, id=id_, name=id_, latitude=lat, longitude=lon, elevation=elevation,
        ids=frozenset(ids), coverage=coverage, priority=priority,
    )


class DeduplicateTest(unittest.TestCase):
    def test_shared_wmo_number_is_one_station_even_far_apart(self) -> None:
        noaa = station("NOAA", "GM000010962", 47.80, 11.01, {"ghcnd:GM000010962", "wmo:10962"}, priority=1)
        dwd = station("DWD", "DWD:02290", 47.90, 11.20, {"dwd:02290", "wmo:10962"})
        kept, dropped = station_sources.deduplicate([noaa, dwd])
        self.assertEqual([s.id for s in kept], ["DWD:02290"])  # national original wins the tie
        self.assertEqual(dropped, [(noaa, dwd)])

    def test_longer_record_wins_over_priority(self) -> None:
        noaa = station("NOAA", "CAN06158355", 43.67, -79.40, {"eccc:6158355"}, coverage=1.0, priority=1)
        eccc = station("ECCC", "ECCC:6158355", 43.67, -79.40, {"eccc:6158355"}, coverage=0.85)
        kept, _ = station_sources.deduplicate([eccc, noaa])
        self.assertEqual([s.id for s in kept], ["CAN06158355"])

    def test_colocated_stations_of_different_databases_match(self) -> None:
        noaa = station("NOAA", "GME00127438", 52.6325, 13.5039, elevation=60.0, priority=1)
        dwd = station("DWD", "DWD:00400", 52.6310, 13.5021, elevation=60.0)
        kept, dropped = station_sources.deduplicate([noaa, dwd])
        self.assertEqual(len(kept), 1)
        self.assertEqual(len(dropped), 1)

    def test_colocated_but_different_height_or_same_database_stay(self) -> None:
        valley = station("NOAA", "A", 47.0, 11.0, elevation=500.0)
        summit = station("DWD", "B", 47.001, 11.001, elevation=1500.0)
        neighbour = station("DWD", "C", 47.002, 11.0, elevation=1490.0)
        kept, dropped = station_sources.deduplicate([valley, summit, neighbour])
        self.assertEqual({s.id for s in kept}, {"A", "B", "C"})
        self.assertEqual(dropped, [])

    def test_far_apart_without_shared_id_stay(self) -> None:
        kept, _ = station_sources.deduplicate(
            [station("NOAA", "A", 52.0, 13.0), station("DWD", "B", 52.1, 13.0)]
        )
        self.assertEqual(len(kept), 2)


class GhcndIdentityTest(unittest.TestCase):
    def test_canadian_and_wmo_keys(self) -> None:
        with mock.patch.object(station_sources, "_GHCND_WMO", {"CAN06158355": "71508"}):
            keys = station_sources.ghcnd_identity_keys("CAN06158355")
        self.assertEqual(keys, {"ghcnd:CAN06158355", "eccc:6158355", "wmo:71508"})

    def test_other_station_only_has_its_own_id(self) -> None:
        with mock.patch.object(station_sources, "_GHCND_WMO", {}):
            self.assertEqual(station_sources.ghcnd_identity_keys("GME00127438"), {"ghcnd:GME00127438"})

    def test_wmo_key_normalises(self) -> None:
        self.assertEqual(station_sources.wmo_key("2978"), "wmo:02978")
        self.assertIsNone(station_sources.wmo_key(None))
        self.assertIsNone(station_sources.wmo_key("n/a"))


class ParserTest(unittest.TestCase):
    def test_dwd_station_list(self) -> None:
        text = (
            "Stations_id von_datum bis_datum Stationshoehe geoBreite geoLaenge Stationsname Bundesland Abgabe\n"
            "----------- --------- ---------\n"
            "00403 19500101 20261113             51     52.4537   13.3017 Berlin-Dahlem (FU)"
            "                       Berlin                                   Frei\n"
        )
        rows = dwd_api._parse_station_list(text)
        self.assertEqual(len(rows), 1)
        self.assertEqual(rows[0]["id"], "00403")
        self.assertEqual(rows[0]["name"], "Berlin-Dahlem (FU)")
        self.assertEqual(rows[0]["first"], date(1950, 1, 1))
        self.assertAlmostEqual(rows[0]["longitude"], 13.3017)

    def test_dwd_product_rows_and_records(self) -> None:
        product = (
            "STATIONS_ID;MESS_DATUM;QN_6;  RS; RSF;SH_TAG;NSH_TAG;eor\n"
            "        403;20200101;    3;   1.5;   0;   2;-999;eor\n"
        )
        rows = dwd_api._parse_product(product)
        client = dwd_api.DWDClient()
        dwd_station = Station("DWD", "DWD:00403", "Dahlem", 52.45, 13.30, extra={"dwd_id": "00403"})
        with mock.patch.object(client, "_station_rows_for", return_value=rows):
            records = client.fetch([dwd_station], "snow_depth", date(2020, 1, 1), date(2020, 1, 31))
        self.assertEqual([(r["description"], r["value"], r["unit"]) for r in records], [("snwd", 20.0, "mm")])

    def test_fmi_observations(self) -> None:
        xml = b"""<wfs:FeatureCollection xmlns:wfs="http://www.opengis.net/wfs/2.0"
            xmlns:gml="http://www.opengis.net/gml/3.2" xmlns:BsWfs="http://xml.fmi.fi/schema/wfs/2.0">
          <wfs:member><BsWfs:BsWfsElement>
            <BsWfs:Location><gml:Point><gml:pos>60.17523 24.94459 </gml:pos></gml:Point></BsWfs:Location>
            <BsWfs:Time>2020-01-01T00:00:00Z</BsWfs:Time>
            <BsWfs:ParameterName>rrday</BsWfs:ParameterName>
            <BsWfs:ParameterValue>-1.0</BsWfs:ParameterValue>
          </BsWfs:BsWfsElement></wfs:member>
          <wfs:member><BsWfs:BsWfsElement>
            <BsWfs:Location><gml:Point><gml:pos>60.17523 24.94459 </gml:pos></gml:Point></BsWfs:Location>
            <BsWfs:Time>2020-01-01T00:00:00Z</BsWfs:Time>
            <BsWfs:ParameterName>tmax</BsWfs:ParameterName>
            <BsWfs:ParameterValue>NaN</BsWfs:ParameterValue>
          </BsWfs:BsWfsElement></wfs:member>
        </wfs:FeatureCollection>"""
        self.assertEqual(fmi_api._parse_observations(xml), [(60.17523, 24.94459, "2020-01-01", "rrday", -1.0)])

    def test_fmi_year_chunks_respect_request_limit(self) -> None:
        chunks = fmi_api._year_chunks(date(2015, 1, 1), date(2024, 12, 31))
        self.assertEqual(chunks[0][0], date(2015, 1, 1))
        self.assertEqual(chunks[-1][1], date(2024, 12, 31))
        self.assertTrue(all((end - start).days < 372 for start, end in chunks))


class PolarStereographicTest(unittest.TestCase):
    def test_pole_and_central_meridian(self) -> None:
        x, y = polar_stereographic(90.0, 0.0, 70.0, -45.0)
        self.assertAlmostEqual(x, 0.0, places=3)
        self.assertAlmostEqual(y, 0.0, places=3)
        x, y = polar_stereographic(70.0, -45.0, 70.0, -45.0)
        self.assertAlmostEqual(x, 0.0, places=3)
        self.assertLess(y, 0.0)

    def test_south_is_mirrored(self) -> None:
        north = polar_stereographic(70.0, 30.0, 70.0, 0.0)
        south = polar_stereographic(-70.0, 30.0, -70.0, 0.0)
        self.assertAlmostEqual(abs(north[0]), abs(south[0]), places=3)
        self.assertAlmostEqual(abs(north[1]), abs(south[1]), places=3)


class SpreadTest(unittest.TestCase):
    def test_spread_picks_far_apart_stations(self) -> None:
        cluster = [station("DWD", f"C{i}", 48.0 + i * 0.001, 11.0) for i in range(10)]
        far = station("DWD", "FAR", 49.0, 12.0)
        chosen = area_analysis._spread([*cluster, far], 2)
        self.assertIn("FAR", {s.id for s in chosen})

    def test_longer_records_come_first(self) -> None:
        short = station("NOAA", "S", 48.0, 11.0, coverage=0.85)
        full = station("NOAA", "F", 48.0, 11.0, coverage=1.0)
        self.assertEqual([s.id for s in area_analysis._spread([short, full], 1)], ["F"])


class ProviderSelectionTest(unittest.TestCase):
    def test_topics_of_all_sources_are_listed_once(self) -> None:
        topics = api_wrapper.get_all_topics_list()
        self.assertEqual(len(topics), len(set(topics)))
        for topic in ("temperature", "temperature_era5", "ice_thickness_satellite"):
            self.assertIn(topic, topics)

    def test_national_sources_only_where_they_have_stations(self) -> None:
        self.assertEqual(api_wrapper.providers_for("temperature", 38.9, -77.0), ["noaa"])
        self.assertEqual(api_wrapper.providers_for("temperature", 52.5, 13.4), ["noaa", "dwd"])
        self.assertEqual(api_wrapper.providers_for("temperature", 60.2, 24.9), ["noaa", "fmi"])
        self.assertEqual(api_wrapper.providers_for("temperature_era5", 0.0, 0.0), ["openmeteo"])

    def test_nearest_station_of_all_sources_wins(self) -> None:
        def record(source, lat):
            return {"date": "2020-01-01", "station": source, "latitude": lat, "longitude": 13.4,
                    "value": 1.0, "description": "tmax", "unit": "°C"}

        answers = {"noaa": [[record("noaa", 53.5)]], "dwd": [[record("dwd", 52.51)]]}
        request = api_wrapper.PointDataRequest(52.5, 13.4, "temperature", date(2020, 1, 1), date(2020, 1, 2))
        with mock.patch.object(
            api_wrapper, "fetch_data_single_topic_single_coordinate",
            side_effect=lambda req, provider, output_dir: [iter(c) for c in answers[provider]],
        ):
            with tempfile.TemporaryDirectory() as folder:
                result = api_wrapper.fetch_data_single_topic_nearest_station(request, output_dir=Path(folder))
        self.assertEqual(result[0][0]["station"], "dwd")
        self.assertEqual(result[0][0]["source"], "DWD")

    def test_all_sources_failing_reports_every_reason(self) -> None:
        request = api_wrapper.PointDataRequest(52.5, 13.4, "temperature", date(2020, 1, 1), date(2020, 1, 2))
        with mock.patch.object(
            api_wrapper, "fetch_data_single_topic_single_coordinate",
            side_effect=station_sources.SourceError("no station"),
        ):
            with self.assertRaises(RuntimeError) as caught:
                api_wrapper.fetch_data_single_topic_nearest_station(request)
        self.assertIn("NOAA", str(caught.exception))
        self.assertIn("DWD", str(caught.exception))


if __name__ == "__main__":
    unittest.main()
