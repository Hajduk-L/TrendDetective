"""Statistical tasks and user-request processing for NOAA time series.

Selected topics are fetched through :mod:`api_wrapper`, aggregated into the
requested time intervals, analyzed with the selected tools, and returned in a
JSON-friendly shape for :class:`interface.UserRequest` and the web interface.
"""

from __future__ import annotations

import math
import tempfile
from abc import ABC, abstractmethod
from dataclasses import dataclass
from datetime import date, datetime, timedelta
from typing import Any

import torch
from scipy import stats

import api_wrapper


DEFAULT_COORDINATE: tuple[float, float] = (38.8951, -77.0364)
INTERVAL_DAYS: dict[str, float] = {
    "Day": 1.0,
    "Month": 30.436875,
    "Year": 365.2425,
}


@dataclass(frozen=True)
class TrendAnalysis:
    """Summary statistics for a linear trend in a time series."""

    slope: float
    intercept: float
    r_value: float
    t_statistic: float
    p_value: float
    standard_error: float
    confidence_interval: tuple[float, float]
    observations: int


@dataclass(frozen=True)
class MannKendallResult:
    """Summary of a two-sided Mann-Kendall monotonic trend test."""

    s_statistic: int
    variance: float
    z_statistic: float
    p_value: float
    tau: float
    trend: str
    observations: int
    alpha: float


def _as_vector(
    data: list[float] | tuple[float, ...] | torch.Tensor, name: str
) -> torch.Tensor:
    """Convert a supported sequence to a finite-checkable CPU vector."""
    vector = torch.as_tensor(data, dtype=torch.float64).detach().cpu()
    if vector.ndim != 1:
        raise ValueError(f"{name} must be a one-dimensional sequence.")
    return vector


def mann_kendall_test(
    time: list[float] | tuple[float, ...] | torch.Tensor,
    values: list[float] | tuple[float, ...] | torch.Tensor,
    alpha: float = 0.05,
) -> MannKendallResult:
    """Test for a monotonic trend with continuity and tie-corrected variance.

    Observations are ordered by ``time``. The standard test assumes independent
    observations; serial correlation can affect its significance estimate.

    :raises ValueError: If inputs are mismatched, invalid, or contain fewer than
        three observations.
    """
    x = _as_vector(time, "time")
    y = _as_vector(values, "values")
    if x.numel() != y.numel():
        raise ValueError("time and values must contain the same number of observations.")
    if x.numel() < 3:
        raise ValueError("At least three observations are required for the Mann-Kendall test.")
    if not torch.isfinite(x).all() or not torch.isfinite(y).all():
        raise ValueError("time and values must contain only finite numbers.")
    if torch.unique(x).numel() != x.numel():
        raise ValueError("time values must be unique for the Mann-Kendall test.")
    if not 0 < alpha < 1:
        raise ValueError("alpha must be between 0 and 1.")

    ordered_values = y[torch.argsort(x)].tolist()
    s_statistic = sum(
        (ordered_values[j] > ordered_values[i])
        - (ordered_values[j] < ordered_values[i])
        for i in range(len(ordered_values) - 1)
        for j in range(i + 1, len(ordered_values))
    )
    n = len(ordered_values)
    tie_counts = torch.unique(y, return_counts=True)[1].tolist()
    tied_pairs = sum(count * (count - 1) * (2 * count + 5) for count in tie_counts)
    variance = (n * (n - 1) * (2 * n + 5) - tied_pairs) / 18

    if variance == 0:
        z_statistic = 0.0
        p_value = 1.0
    else:
        if s_statistic > 0:
            z_statistic = (s_statistic - 1) / math.sqrt(variance)
        elif s_statistic < 0:
            z_statistic = (s_statistic + 1) / math.sqrt(variance)
        else:
            z_statistic = 0.0
        p_value = float(2 * stats.norm.sf(abs(z_statistic)))

    untied_pairs = n * (n - 1) / 2
    value_tied_pairs = sum(count * (count - 1) / 2 for count in tie_counts)
    tau_denominator = math.sqrt(untied_pairs * (untied_pairs - value_tied_pairs))
    tau = s_statistic / tau_denominator if tau_denominator else 0.0
    if p_value < alpha and s_statistic > 0:
        trend = "increasing"
    elif p_value < alpha and s_statistic < 0:
        trend = "decreasing"
    else:
        trend = "no significant trend"

    return MannKendallResult(
        s_statistic=int(s_statistic),
        variance=float(variance),
        z_statistic=float(z_statistic),
        p_value=float(p_value),
        tau=float(tau),
        trend=trend,
        observations=n,
        alpha=float(alpha),
    )


@dataclass
class Task(ABC):
    """Abstract base class for statistical analysis tasks."""

    @abstractmethod
    def process(
        self, X: torch.Tensor, y: torch.Tensor
    ) -> tuple[torch.Tensor, torch.Tensor]:
        """Process feature and value tensors and return two result tensors."""


@dataclass
class LinearRegression(Task):
    """Fit a least-squares line to a time series."""

    def train(
        self, X: torch.Tensor, y: torch.Tensor
    ) -> tuple[torch.Tensor, torch.Tensor]:
        """Return regression coefficients ``(slope, intercept)``."""
        x_values = torch.as_tensor(X, dtype=torch.float32)
        y_values = torch.as_tensor(y, dtype=torch.float32, device=x_values.device)
        if x_values.ndim == 1:
            x_values = x_values.unsqueeze(1)
        if y_values.ndim == 1:
            y_values = y_values.unsqueeze(1)
        if x_values.ndim != 2 or y_values.ndim != 2:
            raise ValueError("X and y must be one- or two-dimensional tensors.")
        if x_values.shape[0] != y_values.shape[0]:
            raise ValueError("X and y must contain the same number of observations.")
        if x_values.shape[0] == 0:
            return (
                torch.zeros(x_values.shape[1], dtype=torch.float32, device=x_values.device),
                torch.zeros(y_values.shape[1], dtype=torch.float32, device=x_values.device),
            )
        design = torch.cat(
            [x_values, torch.ones((x_values.shape[0], 1), dtype=x_values.dtype, device=x_values.device)],
            dim=1,
        )
        solution = torch.linalg.lstsq(design, y_values).solution
        return solution[:-1], solution[-1]

    def process(
        self, X: torch.Tensor, y: torch.Tensor
    ) -> tuple[torch.Tensor, torch.Tensor]:
        """Return the fitted slope and intercept for a single feature."""
        x_values = torch.as_tensor(X, dtype=torch.float32)
        y_values = torch.as_tensor(y, dtype=torch.float32, device=x_values.device)
        if x_values.ndim == 1:
            x_values = x_values.unsqueeze(1)
        if y_values.ndim == 1:
            y_values = y_values.unsqueeze(1)
        if x_values.shape[1] != 1 or y_values.shape[1] != 1:
            raise ValueError("LinearRegression.process expects one feature and one target.")
        if x_values.shape[0] != y_values.shape[0]:
            raise ValueError("X and y must contain the same number of observations.")
        if x_values.shape[0] == 0:
            zero = torch.tensor([0.0], dtype=torch.float32, device=x_values.device)
            return zero, zero.clone()
        weights, bias = self.train(x_values, y_values)
        return weights.reshape(-1), bias.reshape(-1)

    def analyze_trend(
        self,
        time: list[float] | tuple[float, ...] | torch.Tensor,
        values: list[float] | tuple[float, ...] | torch.Tensor,
        confidence_level: float = 0.95,
    ) -> TrendAnalysis:
        """Estimate a linear trend, its two-sided slope test, and confidence interval."""
        x = _as_vector(time, "time")
        y = _as_vector(values, "values")
        if x.numel() != y.numel():
            raise ValueError("time and values must contain the same number of observations.")
        if x.numel() < 3:
            raise ValueError("At least three observations are required for a trend t-test.")
        if not torch.isfinite(x).all() or not torch.isfinite(y).all():
            raise ValueError("time and values must contain only finite numbers.")
        if torch.unique(x).numel() < 2:
            raise ValueError("time must contain at least two distinct values.")
        if not 0 < confidence_level < 1:
            raise ValueError("confidence_level must be between 0 and 1.")

        regression: Any = stats.linregress(x.numpy(), y.numpy())
        degrees_of_freedom = x.numel() - 2
        critical_value = stats.t.ppf((1 + confidence_level) / 2, degrees_of_freedom)
        margin = critical_value * regression.stderr
        if regression.stderr > 0:
            t_statistic = regression.slope / regression.stderr
        elif regression.slope > 0:
            t_statistic = float("inf")
        elif regression.slope < 0:
            t_statistic = float("-inf")
        else:
            t_statistic = 0.0

        return TrendAnalysis(
            slope=float(regression.slope),
            intercept=float(regression.intercept),
            r_value=float(regression.rvalue),
            t_statistic=float(t_statistic),
            p_value=float(regression.pvalue),
            standard_error=float(regression.stderr),
            confidence_interval=(
                float(regression.slope - margin),
                float(regression.slope + margin),
            ),
            observations=int(x.numel()),
        )


@dataclass
class TTest(Task):
    """Welch two-sample t-test comparing early and late observations."""

    def process(
        self, X: torch.Tensor, y: torch.Tensor
    ) -> tuple[torch.Tensor, torch.Tensor]:
        """Return the t-statistic and two-sided p-value for the two time halves."""
        del X
        values = torch.as_tensor(y, dtype=torch.float32).detach().cpu().flatten()
        if not torch.isfinite(values).all():
            raise ValueError("values must contain only finite numbers.")
        count = int(values.numel())
        if count < 4:
            return torch.tensor(0.0), torch.tensor(1.0)

        midpoint = count // 2
        early = values[:midpoint].numpy()
        late = values[midpoint:].numpy()
        result: Any = stats.ttest_ind(late, early, equal_var=False)
        statistic = float(result.statistic)
        p_value = float(result.pvalue)
        if math.isnan(statistic) or math.isnan(p_value):
            difference = float(late.mean() - early.mean())
            if difference == 0:
                statistic, p_value = 0.0, 1.0
            else:
                statistic, p_value = math.copysign(float("inf"), difference), 0.0
        return torch.tensor(statistic, dtype=torch.float32), torch.tensor(
            p_value, dtype=torch.float32
        )


@dataclass
class MannKendall(Task):
    """Mann-Kendall non-parametric monotonic trend test task."""

    def process(
        self, X: torch.Tensor, y: torch.Tensor
    ) -> tuple[torch.Tensor, torch.Tensor]:
        """Return Mann-Kendall S and its two-sided p-value."""
        result = mann_kendall_test(X.flatten(), y.flatten())
        return torch.tensor(float(result.s_statistic)), torch.tensor(result.p_value)


AVAILABLE_TOOLS: dict[str, type[Task]] = {
    "Linear Regression": LinearRegression,
    "Mann-Kendall": MannKendall,
    "t-Test": TTest,
}


def get_available_tools() -> list[str]:
    """Return supported analysis-tool names in alphabetical order."""
    return sorted(AVAILABLE_TOOLS, key=str.lower)


def _extract_coordinates(area: dict[str, Any] | None) -> tuple[float, float]:
    """Extract a representative ``(latitude, longitude)`` from a GeoJSON area."""
    if not isinstance(area, dict):
        return DEFAULT_COORDINATE

    bbox = area.get("bbox")
    if isinstance(bbox, (list, tuple)) and len(bbox) == 4:
        try:
            west, south, east, north = (float(value) for value in bbox)
            if all(math.isfinite(value) for value in (west, south, east, north)):
                return (round((south + north) / 2, 4), round((west + east) / 2, 4))
        except (TypeError, ValueError):
            pass

    geometry = area.get("geometry", area)
    if not isinstance(geometry, dict):
        return DEFAULT_COORDINATE
    coordinates = geometry.get("coordinates")
    try:
        if (
            geometry.get("type") == "Point"
            and isinstance(coordinates, (list, tuple))
            and len(coordinates) >= 2
        ):
            longitude, latitude = float(coordinates[0]), float(coordinates[1])
            if math.isfinite(latitude) and math.isfinite(longitude):
                return (round(latitude, 4), round(longitude, 4))
        if geometry.get("type") == "Polygon" and coordinates and coordinates[0]:
            ring = coordinates[0]
            points = [(float(point[0]), float(point[1])) for point in ring]
            if len(points) > 1 and points[0] == points[-1]:
                points.pop()
            if points:
                longitude = sum(point[0] for point in points) / len(points)
                latitude = sum(point[1] for point in points) / len(points)
                if math.isfinite(latitude) and math.isfinite(longitude):
                    return (round(latitude, 4), round(longitude, 4))
    except (TypeError, ValueError, IndexError):
        pass
    return DEFAULT_COORDINATE


def _load_records_for_topic(
    topic: str,
    latitude: float,
    longitude: float,
    start_date: date,
    end_date: date,
) -> list[dict[str, Any]]:
    """Fetch NOAA observations and consume its file-backed iterators."""
    request = api_wrapper.PointDataRequest(
        latitude=latitude,
        longitude=longitude,
        topic=topic,
        start_date=start_date,
        end_date=end_date,
    )
    records: list[dict[str, Any]] = []
    with tempfile.TemporaryDirectory(prefix="trend-detective-") as output_dir:
        collections = api_wrapper.fetch_data_single_topic_single_coordinate(
            request, provider="noaa", output_dir=output_dir
        )
        for collection in collections:
            records.extend(record for record in collection if isinstance(record, dict))
    return records


def _parse_observation_period(raw_date: str) -> tuple[date, date]:
    """Return the first and last day covered by a NOAA observation date.

    Daily and hourly datasets use ``YYYY-MM-DD`` (optionally followed by a
    time), monthly summaries use ``YYYY-MM`` and annual summaries ``YYYY``.

    :raises ValueError: If the text matches none of these formats.
    """
    text = raw_date.strip()
    if len(text) >= 10:
        day = datetime.fromisoformat(text[:10]).date()
        return day, day
    if len(text) == 7:
        year, month = int(text[:4]), int(text[5:7])
        first = date(year, month, 1)
        next_month = date(year + month // 12, month % 12 + 1, 1)
        return first, next_month - timedelta(days=1)
    if len(text) == 4 and text.isdigit():
        year = int(text)
        return date(year, 1, 1), date(year, 12, 31)
    raise ValueError(f"Unsupported observation date: {raw_date!r}")


def _bin_records(
    records: list[dict[str, Any]],
    start_date: date,
    end_date: date,
    interval_length: tuple[float, str],
) -> tuple[list[str], list[float]]:
    """Average numeric NOAA measurements into the requested date intervals."""
    interval_value, interval_unit = interval_length
    try:
        step_days = float(interval_value) * INTERVAL_DAYS[interval_unit]
    except (KeyError, TypeError, ValueError) as error:
        raise ValueError("interval_length must use a positive Day, Month, or Year interval.") from error
    if not math.isfinite(step_days) or step_days <= 0:
        raise ValueError("interval_length must use a positive Day, Month, or Year interval.")

    bins: dict[int, list[float]] = {}
    for record in records:
        raw_value = record.get("value")
        raw_date = record.get("date")
        if (
            isinstance(raw_value, bool)
            or not isinstance(raw_value, (int, float, str))
            or not isinstance(raw_date, str)
        ):
            continue
        try:
            value = float(raw_value)
            period_start, period_end = _parse_observation_period(raw_date)
        except (TypeError, ValueError):
            continue
        # Monthly / annual values count if their period overlaps the request.
        if not math.isfinite(value) or period_end < start_date or period_start > end_date:
            continue
        # Place the value at the middle of its period, clamped to the range.
        midpoint = period_start + (period_end - period_start) / 2
        observation_date = min(max(midpoint, start_date), end_date)
        bin_index = math.floor((observation_date - start_date).days / step_days)
        bins.setdefault(bin_index, []).append(value)

    labels: list[str] = []
    means: list[float] = []
    for bin_index in sorted(bins):
        bin_date = start_date + timedelta(days=round(bin_index * step_days))
        labels.append(bin_date.strftime("%d.%m.%Y"))
        means.append(round(sum(bins[bin_index]) / len(bins[bin_index]), 3))
    return labels, means


def _safe_float(value: float, digits: int = 4) -> float | None:
    """Round a finite result for JSON transport; encode undefined values as null."""
    value = float(value)
    return round(value, digits) if math.isfinite(value) else None


def _station_from_records(
    records: list[dict[str, Any]], latitude: float, longitude: float
) -> dict[str, Any] | None:
    """Return id, name, position and distance of the station that measured ``records``.

    Land datasets come from one fixed station. Marine datasets combine all
    ships and buoys in a box; then the centre of their reported positions is
    returned and the name says how many platforms were combined.
    """
    positions: list[tuple[float, float]] = []
    station_ids: set[str] = set()
    first: dict[str, Any] | None = None
    for record in records:
        try:
            station_latitude = float(record["latitude"])
            station_longitude = float(record["longitude"])
        except (KeyError, TypeError, ValueError):
            continue
        if not (math.isfinite(station_latitude) and math.isfinite(station_longitude)):
            continue
        positions.append((station_latitude, station_longitude))
        station_ids.add(str(record.get("station")))
        if first is None:
            first = record
    if first is None:
        return None

    if len(station_ids) > 1:
        station_latitude = sum(lat for lat, _ in positions) / len(positions)
        station_longitude = sum(lon for _, lon in positions) / len(positions)
        station_id = None
        name = f"{len(station_ids)} ships / buoys combined (centre of their positions)"
        elevation = None
    else:
        station_latitude, station_longitude = positions[0]
        station_id = first.get("station")
        name = first.get("name")
        elevation = first.get("elevation")
    return {
        "id": station_id,
        "name": name,
        "latitude": round(station_latitude, 5),
        "longitude": round(station_longitude, 5),
        "elevation": elevation if isinstance(elevation, (int, float)) else None,
        "distance_km": round(
            _distance_km(latitude, longitude, station_latitude, station_longitude), 1
        ),
    }


def _distance_km(lat1: float, lon1: float, lat2: float, lon2: float) -> float:
    """Great-circle distance between two points in kilometres."""
    phi1, phi2 = math.radians(lat1), math.radians(lat2)
    d_phi = phi2 - phi1
    d_lambda = math.radians(lon2 - lon1)
    a = math.sin(d_phi / 2) ** 2 + math.cos(phi1) * math.cos(phi2) * math.sin(d_lambda / 2) ** 2
    return 6371.0088 * 2 * math.asin(math.sqrt(min(1.0, a)))


def process_user_request(user_request: Any) -> dict[str, Any]:
    """Fetch, aggregate, and analyze all selected topics in a ``UserRequest``.

    The returned dictionary is stored on ``AppInterface.last_task_results`` and
    is consumed by the frontend for charts and map overlays.
    """
    selected_topics = [
        topic for topic, checked in user_request.topics.items() if checked
    ]
    selected_tools = {
        tool for tool, checked in user_request.tools.items() if checked
    }
    start_date, end_date = user_request.timeintervall
    latitude, longitude = _extract_coordinates(user_request.area)
    interval_length = user_request.interval_length

    topic_results: dict[str, Any] = {}
    map_features: list[dict[str, Any]] = []
    station_features: dict[str, dict[str, Any]] = {}

    for topic in selected_topics:
        try:
            records = _load_records_for_topic(
                topic, latitude, longitude, start_date, end_date
            )
        except (RuntimeError, ValueError) as error:
            # One topic without a nearby station must not cancel the others
            # (NOAAError is a RuntimeError). The frontend shows the message.
            topic_results[topic] = {
                "labels": [],
                "values": [],
                "mean": None,
                "coordinates": [latitude, longitude],
                "station": None,
                "variables": [],
                "unit": None,
                "error": str(error),
                "tools": {},
            }
            continue
        station = _station_from_records(records, latitude, longitude)
        variables = sorted({str(r["description"]) for r in records if r.get("description")})
        units = {r.get("unit") for r in records}
        # Only label the axis when every merged variable shares one unit.
        unit = units.pop() if len(units) == 1 else None
        if station is not None:
            station_key = str(station["id"] or f"{station['latitude']},{station['longitude']}")
            feature = station_features.setdefault(
                station_key,
                {
                    "type": "Feature",
                    "geometry": {
                        "type": "Point",
                        "coordinates": [station["longitude"], station["latitude"]],
                    },
                    "properties": {
                        "kind": "Measuring station",
                        "station": station["id"],
                        "name": station["name"],
                        "latitude": station["latitude"],
                        "longitude": station["longitude"],
                        "elevation_m": station["elevation"],
                        "distance_km": station["distance_km"],
                        "topics": [],
                        "color": "#7c3aed",
                    },
                },
            )
            feature["properties"]["topics"].append(topic)
        labels, values = _bin_records(
            records, start_date, end_date, interval_length
        )
        sample_count = len(values)
        x = torch.arange(sample_count, dtype=torch.float32).unsqueeze(1)
        y = torch.tensor(values, dtype=torch.float32).unsqueeze(1)
        tool_results: dict[str, Any] = {}
        slope_value = 0.0

        if "Linear Regression" in selected_tools:
            slope, intercept = LinearRegression().process(x, y)
            slope_value = float(slope[0].item()) if slope.numel() else 0.0
            intercept_value = float(intercept[0].item()) if intercept.numel() else 0.0
            trend_line = [
                round(slope_value * index + intercept_value, 3)
                for index in range(sample_count)
            ]
            tool_results["Linear Regression"] = {
                "slope": _safe_float(slope_value),
                "intercept": _safe_float(intercept_value),
                "trend_line": trend_line,
                "observations": sample_count,
            }

        if "t-Test" in selected_tools:
            if sample_count < 4:
                tool_results["t-Test"] = {
                    "available": False,
                    "error": "At least four intervals are required to compare two samples.",
                    "observations": sample_count,
                }
            else:
                statistic, p_value = TTest().process(x, y)
                statistic_value = float(statistic.item())
                p_value_value = float(p_value.item())
                tool_results["t-Test"] = {
                    "available": True,
                    "t_statistic": _safe_float(statistic_value),
                    "p_value": _safe_float(p_value_value),
                    "significant": bool(p_value_value < 0.05),
                    "observations": sample_count,
                }

        if "Mann-Kendall" in selected_tools:
            if sample_count < 3:
                tool_results["Mann-Kendall"] = {
                    "available": False,
                    "error": "At least three intervals are required for the Mann-Kendall test.",
                    "observations": sample_count,
                }
            else:
                result = mann_kendall_test(x.flatten(), y.flatten())
                tool_results["Mann-Kendall"] = {
                    "available": True,
                    "s_statistic": result.s_statistic,
                    "variance": _safe_float(result.variance),
                    "z_statistic": _safe_float(result.z_statistic),
                    "p_value": _safe_float(result.p_value),
                    "tau": _safe_float(result.tau),
                    "trend": result.trend,
                    "observations": result.observations,
                    "alpha": result.alpha,
                }

        mean_value = round(sum(values) / sample_count, 3) if sample_count else None
        topic_results[topic] = {
            "labels": labels,
            "values": values,
            "mean": mean_value,
            "coordinates": [latitude, longitude],
            "station": station,
            "variables": variables,
            "unit": unit,
            "tools": tool_results,
        }

        properties: dict[str, Any] = {
            "topic": topic,
            "mean": mean_value,
            "samples": sample_count,
            "color": "#dc2626" if slope_value > 0 else "#2563eb",
        }
        regression_result = tool_results.get("Linear Regression")
        if regression_result is not None:
            properties["slope"] = regression_result["slope"]
            properties["intercept"] = regression_result["intercept"]
        ttest_result = tool_results.get("t-Test")
        if ttest_result is not None and ttest_result.get("available"):
            properties["t_statistic"] = ttest_result["t_statistic"]
            properties["p_value"] = ttest_result["p_value"]
        mann_kendall_result = tool_results.get("Mann-Kendall")
        if mann_kendall_result is not None and mann_kendall_result.get("available"):
            properties["mann_kendall_trend"] = mann_kendall_result["trend"]
            properties["mann_kendall_p_value"] = mann_kendall_result["p_value"]

        if isinstance(user_request.area, dict) and isinstance(
            user_request.area.get("geometry"), dict
        ):
            geometry = user_request.area["geometry"]
        else:
            geometry = {
                "type": "Point",
                "coordinates": [longitude, latitude],
            }
        map_features.append(
            {"type": "Feature", "geometry": geometry, "properties": properties}
        )

    map_layers: list[dict[str, Any]] = []
    if map_features:
        map_layers.append(
            {
                "type": "geojson",
                "id": "user-request-results",
                "data": {"type": "FeatureCollection", "features": map_features},
            }
        )

    if station_features:
        # Drawn on top of the result layer so the exact measuring point stays visible.
        map_layers.append(
            {
                "type": "geojson",
                "id": "measuring-stations",
                "pointRadius": 8,
                "data": {
                    "type": "FeatureCollection",
                    "features": list(station_features.values()),
                },
            }
        )

    return {"topics": topic_results, "map_layers": map_layers}
