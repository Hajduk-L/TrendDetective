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
from typing import Any, Sequence

import numpy as np
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


def _mann_kendall_s(ordered: np.ndarray) -> int:
    """Mann-Kendall ``S``: sum of ``sign(y_j - y_i)`` over all pairs ``i < j``.

    Vectorised row by row, so ten years of daily values (~3,650 points, 6.7
    million pairs) take milliseconds instead of the seconds a Python double
    loop needs.
    """
    n = ordered.size
    if n > 3000:
        # O(n log n): with distinct times, Kendall's tau-b is S / sqrt(n0 (n0 - t)),
        # n0 = n(n-1)/2 and t the pairs tied in the values.
        tau = stats.kendalltau(np.arange(n), ordered).statistic
        counts = np.unique(ordered, return_counts=True)[1]
        n0 = n * (n - 1) / 2
        tied = float(np.sum(counts * (counts - 1) / 2))
        return int(round(float(tau) * math.sqrt(n0 * (n0 - tied)))) if math.isfinite(tau) else 0
    total = 0
    for i in range(n - 1):
        total += int(np.sign(ordered[i + 1 :] - ordered[i]).sum())
    return total


def lag1_autocorrelation(values: Sequence[float]) -> float:
    """Lag-1 autocorrelation of a series (0 for fewer than three values)."""
    y = np.asarray(values, dtype=np.float64)
    if y.size < 3:
        return 0.0
    centred = y - y.mean()
    denominator = float(np.dot(centred, centred))
    if denominator == 0:
        return 0.0
    return float(np.dot(centred[:-1], centred[1:]) / denominator)


def effective_sample_size(n: int, r1: float) -> float:
    """Effective number of independent values of an AR(1) series.

    ``n_eff = n (1 - r1) / (1 + r1)`` (Santer et al. 2000). Daily climate data
    is strongly autocorrelated (a warm day follows a warm day), so the plain
    ``n`` overstates how much independent information a series holds and
    makes trends look more significant than they are. Negative ``r1`` is
    treated as 0 (no inflation), and the result never drops below 3.
    """
    r1 = min(max(r1, 0.0), 0.99)
    return max(3.0, n * (1 - r1) / (1 + r1))


def _autocorrelations(values: np.ndarray) -> np.ndarray:
    """Autocorrelation at lags ``0 .. n-1`` (FFT based)."""
    n = values.size
    centred = values - values.mean()
    size = 1 << (2 * n - 1).bit_length()
    spectrum = np.fft.rfft(centred, size)
    acov = np.fft.irfft(spectrum * np.conj(spectrum), size)[:n]
    return acov / acov[0] if acov[0] > 0 else np.zeros(n)


def hamed_rao_variance_factor(time: Sequence[float], values: Sequence[float]) -> float:
    """Variance inflation ``n / n*`` of the Mann-Kendall S (Hamed & Rao 1998).

    The ranks of the series without its Sen slope are tested for
    autocorrelation; every lag with a significant autocorrelation (95 %)
    widens the variance of S. Returns 1.0 when there is none.
    """
    x = np.asarray(time, dtype=np.float64)
    y = np.asarray(values, dtype=np.float64)
    n = y.size
    if n < 10:
        return 1.0
    order = np.argsort(x)
    x, y = x[order], y[order]
    slope = float(np.median(theil_sen(x, y).slope))
    detrended = y - slope * x
    ranks = stats.rankdata(detrended)
    rho = _autocorrelations(ranks)[1:]
    lags = np.arange(1, n)
    significant = np.abs(rho) > stats.norm.ppf(0.975) / math.sqrt(n)
    if not significant.any():
        return 1.0 if rho[0] <= 0 else max(1.0, (1 + float(rho[0])) / (1 - min(float(rho[0]), 0.98)))
    k = lags[significant]
    weights = (n - k) * (n - k - 1) * (n - k - 2)
    factor = 1 + 2 * float(np.sum(weights * rho[significant])) / (n * (n - 1) * (n - 2))
    # Hamed-Rao drops the many small but non-significant lags of a persistent
    # series and then underestimates the inflation (17 % false trends in 10
    # years of AR(1) daily noise). The AR(1) factor (1 + r1) / (1 - r1) of
    # the same ranks is a floor for it.
    r1 = float(rho[0])
    ar1_factor = (1 + r1) / (1 - r1) if 0 < r1 < 0.99 else 1.0
    return max(factor, ar1_factor, 1e-6)


@dataclass(frozen=True)
class TheilSenResult:
    """Median of all pairwise slopes, a trend estimate robust to outliers."""

    slope: float
    intercept: float
    low_slope: float
    high_slope: float
    observations: int
    exact: bool


THEIL_SEN_EXACT_LIMIT: int = 2500
"""Up to this many values all pairwise slopes are used; above it a fixed random sample."""

THEIL_SEN_SAMPLE_PAIRS: int = 2_000_000


def theil_sen(
    time: Sequence[float] | torch.Tensor,
    values: Sequence[float] | torch.Tensor,
    confidence_level: float = 0.95,
    variance_factor: float = 1.0,
) -> TheilSenResult:
    """Sen's slope with a Mann-Kendall based confidence interval (Sen 1968).

    For long series (more than :data:`THEIL_SEN_EXACT_LIMIT` values, e.g. 30
    years of daily data = 60 million pairs) the median is taken over a
    reproducible random sample of :data:`THEIL_SEN_SAMPLE_PAIRS` pairs.

    :param variance_factor: Widens the interval for autocorrelated data, see
        :func:`hamed_rao_variance_factor`.
    :raises ValueError: For fewer than three values or a single distinct time.
    """
    x = np.asarray(time, dtype=np.float64).ravel()
    y = np.asarray(values, dtype=np.float64).ravel()
    if x.size != y.size:
        raise ValueError("time and values must contain the same number of observations.")
    if x.size < 3 or np.unique(x).size < 2:
        raise ValueError("At least three values at two different times are required.")
    n = x.size
    exact = n <= THEIL_SEN_EXACT_LIMIT
    if exact:
        i, j = np.triu_indices(n, k=1)
    else:
        rng = np.random.default_rng(12345)
        i = rng.integers(0, n, THEIL_SEN_SAMPLE_PAIRS)
        j = rng.integers(0, n, THEIL_SEN_SAMPLE_PAIRS)
    dx = x[j] - x[i]
    keep = dx != 0
    slopes = np.sort((y[j][keep] - y[i][keep]) / dx[keep])
    slope = float(np.median(slopes))
    z = stats.norm.ppf((1 + confidence_level) / 2)
    variance_s = n * (n - 1) * (2 * n + 5) / 18 * max(variance_factor, 1e-6)
    all_pairs = n * (n - 1) / 2
    c = z * math.sqrt(variance_s)
    low_q = min(1.0, max(0.0, (all_pairs - c) / 2 / all_pairs))
    high_q = min(1.0, max(0.0, (all_pairs + c) / 2 / all_pairs))
    return TheilSenResult(
        slope=slope,
        intercept=float(np.median(y) - slope * np.median(x)),
        low_slope=float(np.quantile(slopes, low_q)),
        high_slope=float(np.quantile(slopes, high_q)),
        observations=n,
        exact=exact,
    )


SEASONAL_HARMONICS: int = 4
"""Harmonics of the annual cycle fitted to data finer than monthly."""


def remove_seasonal_cycle(
    time: Sequence[float], values: Sequence[float], season_length: float | None
) -> np.ndarray:
    """Values without their mean seasonal cycle (the overall mean is kept).

    ``season_length`` is one year in units of ``time`` (365.24 for days, 12
    for months, 1 for decimal years). Without one, or for a series shorter
    than two years, the values are returned unchanged.

    * Few distinct times of year (monthly values: 12): each one's own mean
      is subtracted.
    * Finer data (daily, multi-day intervals): a smooth cycle of
      :data:`SEASONAL_HARMONICS` harmonics is fitted *together with a linear
      trend* and only the cycle is subtracted. Twelve monthly steps would
      leave a sawtooth inside every month that the trend tests mistook for
      signal (Mann-Kendall flagged a third of trend-free daily series).
    """
    x = np.asarray(time, dtype=np.float64)
    y = np.asarray(values, dtype=np.float64).copy()
    if not season_length or season_length <= 0 or x.size < 4:
        return y
    if (x.max() - x.min()) < 2 * season_length * 0.98:
        return y
    phase = np.mod(x, season_length) / season_length
    keys = np.round(phase * 1000).astype(int) % 1000
    distinct = np.unique(keys)
    if distinct.size < 2:
        return y
    if distinct.size <= 24:
        for key in distinct:
            mask = keys == key
            y[mask] -= y[mask].mean()
        return y + np.asarray(values, dtype=np.float64).mean()
    harmonics = min(SEASONAL_HARMONICS, distinct.size // 6)
    angle = 2 * np.pi * x / season_length
    columns = [np.ones_like(x), (x - x.mean()) / (x.std() or 1.0)]
    for k in range(1, harmonics + 1):
        columns += [np.cos(k * angle), np.sin(k * angle)]
    design = np.column_stack(columns)
    coefficients, *_ = np.linalg.lstsq(design, y, rcond=None)
    cycle = design[:, 2:] @ coefficients[2:]
    return y - cycle


@dataclass(frozen=True)
class PettittResult:
    """Most likely single shift in the level of a series (Pettitt 1979)."""

    index: int
    """Last position (0-based, in time order) before the shift."""
    k_statistic: float
    p_value: float
    mean_before: float
    mean_after: float
    observations: int


def pettitt_test(
    time: Sequence[float] | torch.Tensor, values: Sequence[float] | torch.Tensor
) -> PettittResult:
    """Non-parametric test for one change point in the median.

    ``U_t = Σ_{i≤t} (2·rank_i − n − 1)``; the change point is where ``|U_t|``
    is largest, and ``p ≈ 2 exp(−6K² / (n³ + n²))``. For autocorrelated data
    K is first divided by ``sqrt(n / n_eff)`` (AR(1) approximation).

    :raises ValueError: For fewer than four values.
    """
    x = np.asarray(time, dtype=np.float64).ravel()
    y = np.asarray(values, dtype=np.float64).ravel()
    if x.size != y.size:
        raise ValueError("time and values must contain the same number of observations.")
    n = y.size
    if n < 4:
        raise ValueError("At least four values are required for the Pettitt test.")
    order = np.argsort(x, kind="stable")
    y = y[order]
    ranks = stats.rankdata(y)
    u = np.cumsum(2 * ranks - n - 1)[:-1]
    t = int(np.argmax(np.abs(u)))
    k = float(abs(u[t]))
    # Autocorrelation makes |U| wander further by chance; shrink K by the
    # square root of n / n_eff of the series without the detected shift.
    residual = y.copy()
    residual[: t + 1] -= residual[: t + 1].mean()
    residual[t + 1 :] -= residual[t + 1 :].mean()
    inflation = n / effective_sample_size(n, lag1_autocorrelation(residual))
    k_adjusted = k / math.sqrt(inflation)
    p_value = float(min(1.0, 2 * math.exp(-6 * k_adjusted * k_adjusted / (n**3 + n**2))))
    return PettittResult(
        index=t,
        k_statistic=k,
        p_value=p_value,
        mean_before=float(y[: t + 1].mean()),
        mean_after=float(y[t + 1 :].mean()),
        observations=int(n),
    )


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

    ordered = y[torch.argsort(x)].numpy()
    s_statistic = _mann_kendall_s(ordered)
    n = int(ordered.size)
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
        # Solved in float64 with centred features: in float32 the default
        # lstsq driver returned a wrong fit for long series (ten years of
        # daily values gave +0.0065 °C/day and an intercept of 0 for a series
        # without trend around 15 °C).
        x64 = x_values.to(torch.float64)
        y64 = y_values.to(torch.float64)
        x_mean = x64.mean(dim=0, keepdim=True)
        design = torch.cat(
            [x64 - x_mean, torch.ones((x64.shape[0], 1), dtype=torch.float64, device=x64.device)],
            dim=1,
        )
        solution = torch.linalg.lstsq(design, y64, driver="gelsd" if design.device.type == "cpu" else None).solution
        weights = solution[:-1]
        bias = solution[-1] - (x_mean @ weights).reshape(-1)
        return weights.to(torch.float32), bias.to(torch.float32)

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


@dataclass
class SensSlope(Task):
    """Theil-Sen trend: the median of all pairwise slopes (robust to outliers)."""

    def process(
        self, X: torch.Tensor, y: torch.Tensor
    ) -> tuple[torch.Tensor, torch.Tensor]:
        """Return Sen's slope and its intercept."""
        result = theil_sen(X.flatten().tolist(), y.flatten().tolist())
        return torch.tensor([result.slope]), torch.tensor([result.intercept])


@dataclass
class ChangePoint(Task):
    """Pettitt test for one abrupt shift in the level of a series."""

    def process(
        self, X: torch.Tensor, y: torch.Tensor
    ) -> tuple[torch.Tensor, torch.Tensor]:
        """Return the index of the last value before the shift and its p-value."""
        result = pettitt_test(X.flatten().tolist(), y.flatten().tolist())
        return torch.tensor(float(result.index)), torch.tensor(result.p_value)


AVAILABLE_TOOLS: dict[str, type[Task]] = {
    "Linear Regression": LinearRegression,
    "Mann-Kendall": MannKendall,
    "t-Test": TTest,
    "Sen's Slope": SensSlope,
    "Change Point": ChangePoint,
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
    """Fetch the nearest station's observations from all data sources of the topic.

    See :func:`api_wrapper.fetch_data_single_topic_nearest_station`: NOAA and
    the national networks (DWD, ECCC, FMI) are asked in parallel and the
    station closest to the point wins.
    """
    request = api_wrapper.PointDataRequest(
        latitude=latitude,
        longitude=longitude,
        topic=topic,
        start_date=start_date,
        end_date=end_date,
    )
    records: list[dict[str, Any]] = []
    with tempfile.TemporaryDirectory(prefix="trend-detective-") as output_dir:
        collections = api_wrapper.fetch_data_single_topic_nearest_station(
            request, output_dir=output_dir
        )
        for collection in collections:
            records.extend(record for record in collection if isinstance(record, dict))
    return records


VARIABLE_NAMES: dict[str, str] = {
    "tmax": "maximum",
    "tmin": "minimum",
    "tavg": "average",
    "emxt": "extreme maximum",
    "emnt": "extreme minimum",
    "prcp": "precipitation",
    "mdpr": "multiday precipitation",
    "emxp": "wettest day",
    "dp01": "share of days with ≥ 0.25 mm",
    "dp10": "share of days with ≥ 2.5 mm",
    "dp1x": "share of days with ≥ 25 mm",
    "snow": "snowfall",
    "snwd": "snow depth",
    "awnd": "average wind speed",
    "rhav": "average",
    "rhmn": "minimum",
    "rhmx": "maximum",
    "mnpn": "minimum",
    "mxpn": "maximum",
    "air_temp": "air",
    "sea_surf_temp": "sea surface",
    "dew_pt_temp": "dew point",
    "wsfg": "peak gust",
    "viirs_ice_thickness": "ice thickness",
    "dewp": "dew point",
    "pmsl": "sea-level pressure",
    "cldc": "cloud cover",
    "tsun": "sunshine",
    "srad": "solar radiation",
    "et0": "evapotranspiration",
    "soilm": "soil moisture",
    "soilt": "soil temperature",
}
"""Readable names of common NOAA codes, used in the per-variable result keys."""


def variable_label(topic: str, description: str) -> str:
    """Result key for one variable of a topic, e.g. ``temperature · minimum (TMIN)``."""
    code = description.upper()
    name = VARIABLE_NAMES.get(description.lower())
    return f"{topic} · {name} ({code})" if name else f"{topic} · {code}"


def split_by_variable(
    topic: str, records: list[dict[str, Any]]
) -> list[tuple[str, list[dict[str, Any]]]]:
    """Group a topic's records by NOAA code, one ``(result key, records)`` pair each.

    A topic such as ``temperature`` delivers TMAX, TMIN and TAVG; their values
    must not be averaged together. A topic with a single variable keeps the
    plain topic name as its key.
    """
    groups: dict[str, list[dict[str, Any]]] = {}
    for record in records:
        groups.setdefault(str(record.get("description") or ""), []).append(record)
    if len(groups) <= 1:
        return [(topic, records)]
    return [
        (variable_label(topic, description) if description else topic, group)
        for description, group in sorted(groups.items())
    ]


MIN_VARIABLE_SHARE: float = 0.05
"""A secondary code with fewer values than this share of the largest one is hidden."""


def drop_sparse_variables(
    groups: list[tuple[str, list[dict[str, Any]]]],
) -> list[tuple[str, list[dict[str, Any]]]]:
    """Leave out codes with only a handful of values next to a well-filled one.

    Stations report occasional secondary codes (a multi-day snowfall total
    MDSF once in 30 years next to 10,000 daily SNOW values). Each would get
    a card with one or two points and no possible trend. A code is dropped
    when it has fewer than 10 values *and* fewer than
    :data:`MIN_VARIABLE_SHARE` of the values of the largest code.
    """
    if len(groups) <= 1:
        return groups
    largest = max(len(records) for _, records in groups)
    kept = [
        (key, records)
        for key, records in groups
        if len(records) >= 10 or len(records) >= MIN_VARIABLE_SHARE * largest
    ]
    return kept or groups


PRECIPITATION_AMOUNT_CODES: frozenset[str] = frozenset({"prcp", "mdpr"})
"""Precipitation totals (mm) that are shown as a rate in ``mm/day``."""

RAIN_DAY_COUNT_CODES: frozenset[str] = frozenset({"dp01", "dp10", "dp1x"})
"""Monthly/annual counts of rain days, shown as the share of days in ``%``."""


def precipitation_as_density(records: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """Express precipitation totals and rain-day counts per day of their period.

    NOAA reports precipitation as a total over the observation period: one
    day for daily PRCP, a whole month or year for the monthly/annual
    summaries, and ``DAPR`` days for a multiday total (``MDPR``). The rain-day
    counts DP01/DP10/DP1X count days of a month or year. Plotted as-is, a
    monthly count lands on a single day ("3 days of rain on one day") and
    totals of different period lengths cannot be compared.

    This returns copies in which

    * PRCP/MDPR totals are divided by the number of days they cover
      (unit ``mm/day``); an MDPR total is spread over its DAPR days,
    * DP01/DP10/DP1X counts become the share of days with rain (unit ``%``),
    * DAPR records (a day count, not an amount) are dropped.

    Every other record is returned unchanged.
    """
    multiday_days: dict[tuple[Any, str], float] = {}
    for record in records:
        if str(record.get("description") or "").lower() == "dapr":
            try:
                days = float(record["value"])
            except (KeyError, TypeError, ValueError):
                continue
            if math.isfinite(days) and days >= 1:
                multiday_days[(record.get("station"), str(record.get("date")))] = days

    converted: list[dict[str, Any]] = []
    for record in records:
        code = str(record.get("description") or "").lower()
        if code == "dapr":
            continue
        if code not in PRECIPITATION_AMOUNT_CODES and code not in RAIN_DAY_COUNT_CODES:
            converted.append(record)
            continue
        try:
            value = float(record["value"])
            period_start, period_end = _parse_observation_period(str(record["date"]))
        except (KeyError, TypeError, ValueError):
            converted.append(record)
            continue
        days = float((period_end - period_start).days + 1)
        if code == "mdpr":
            days = multiday_days.get((record.get("station"), str(record.get("date"))), days)
        if code in RAIN_DAY_COUNT_CODES:
            new_value, unit = 100.0 * value / days, "% of days"
        else:
            new_value, unit = value / days, "mm/day"
        converted.append({**record, "value": round(new_value, 4), "unit": unit})
    return converted


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
    _, labels, means = bin_records_indexed(records, start_date, end_date, interval_length)
    return labels, means


def interval_step_days(interval_length: tuple[float, str]) -> float:
    """Length of one interval in days, e.g. ``(1, "Month")`` -> 30.44."""
    interval_value, interval_unit = interval_length
    try:
        step_days = float(interval_value) * INTERVAL_DAYS[interval_unit]
    except (KeyError, TypeError, ValueError) as error:
        raise ValueError("interval_length must use a positive Day, Month, or Year interval.") from error
    if not math.isfinite(step_days) or step_days <= 0:
        raise ValueError("interval_length must use a positive Day, Month, or Year interval.")
    return step_days


DIRECTION_CODES: frozenset[str] = frozenset(
    {"awdr", "wdf1", "wdf2", "wdf5", "wdfg", "wdfi", "wdfm", "wind_dir", "rel_wind_dir"}
)
"""Codes holding a compass direction in degrees."""


def is_direction(code: str) -> bool:
    """Whether ``code`` is a compass direction (averaged on the circle, no trend)."""
    code = code.lower()
    return code in DIRECTION_CODES or code.endswith("_direction") or code.endswith("_dir")


def _circular_mean(degrees: list[float]) -> float:
    """Mean direction: 350° and 10° give 0°, not 180°."""
    x = sum(math.cos(math.radians(d)) for d in degrees)
    y = sum(math.sin(math.radians(d)) for d in degrees)
    if abs(x) < 1e-12 and abs(y) < 1e-12:
        return float("nan")
    value = math.degrees(math.atan2(y, x)) % 360
    return 0.0 if value >= 359.9995 else value


MIN_BIN_COVERAGE: float = 0.75
"""Share of an interval's days that must have data for its mean to be used.

A year with data only for January to March has a mean far below the
others; counted as a full year it can invert a trend (−3.5 °C/decade in a
test). Partly covered intervals at the ends of the range and inside gaps are
therefore left out."""


def _calendar_step(interval_length: tuple[float, str]) -> tuple[str, int] | None:
    """``("Month", k)`` / ``("Year", k)`` for whole-number calendar intervals, else ``None``."""
    value, unit = interval_length
    if unit in ("Month", "Year") and float(value) >= 1 and float(value) == int(value):
        return unit, int(value)
    return None


def bin_bounds(index: int, start_date: date, interval_length: tuple[float, str]) -> tuple[date, date]:
    """First and last day of interval number ``index``.

    Whole-number Month / Year intervals follow the calendar (interval 0 is
    the calendar month / year containing ``start_date``), so a "1 Month"
    interval is always a real month. Other intervals are fixed windows of
    :func:`interval_step_days` days counted from ``start_date``.
    """
    calendar = _calendar_step(interval_length)
    if calendar is None:
        step_days = interval_step_days(interval_length)
        first = start_date + timedelta(days=round(index * step_days))
        last = start_date + timedelta(days=round((index + 1) * step_days)) - timedelta(days=1)
        return first, max(first, last)
    unit, k = calendar
    if unit == "Year":
        return date(start_date.year + index * k, 1, 1), date(start_date.year + (index + 1) * k - 1, 12, 31)
    base = start_date.year * 12 + start_date.month - 1 + index * k
    first = date(base // 12, base % 12 + 1, 1)
    after = base + k
    return first, date(after // 12, after % 12 + 1, 1) - timedelta(days=1)


def bin_index_of(day: date, start_date: date, interval_length: tuple[float, str]) -> int:
    """Interval number containing ``day`` (see :func:`bin_bounds`)."""
    calendar = _calendar_step(interval_length)
    if calendar is None:
        return math.floor((day - start_date).days / interval_step_days(interval_length))
    unit, k = calendar
    if unit == "Year":
        return (day.year - start_date.year) // k
    return ((day.year * 12 + day.month) - (start_date.year * 12 + start_date.month)) // k


def bin_records_indexed(
    records: list[dict[str, Any]],
    start_date: date,
    end_date: date,
    interval_length: tuple[float, str],
    stats: dict[str, Any] | None = None,
) -> tuple[list[int], list[str], list[float]]:
    """Mean of every interval, with its interval number and start-date label.

    * Intervals follow :func:`bin_bounds` (calendar months / years where
      possible).
    * A value goes to the interval containing the middle of its observation
      period (a monthly value to its month, an annual value to its year).
    * Intervals whose days are covered by data for less than
      :data:`MIN_BIN_COVERAGE` (counting only days inside the requested
      range) are left out; ``stats["dropped"]`` receives their number.
    * Intervals without values are left out too, so the numbers have gaps.
      Trends must be fitted against these numbers, not ``0, 1, 2, …``:
      otherwise a gap of a year would be squeezed to one interval.
    """
    interval_step_days(interval_length)  # validates the interval
    circular = bool(records) and all(is_direction(str(r.get("description") or "")) for r in records)
    sums: dict[int, list[float]] = {}
    covered: dict[int, set[int]] = {}
    first_day, last_day = start_date.toordinal(), end_date.toordinal()
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
        if not math.isfinite(value) or period_end < start_date or period_start > end_date:
            continue
        midpoint = period_start + (period_end - period_start) / 2
        index = bin_index_of(midpoint, start_date, interval_length)
        sums.setdefault(index, []).append(value)
        days = covered.setdefault(index, set())
        days.update(
            range(max(period_start.toordinal(), first_day), min(period_end.toordinal(), last_day) + 1)
        )

    indices: list[int] = []
    labels: list[str] = []
    means: list[float] = []
    dropped = 0
    for index in sorted(sums):
        bin_first, bin_last = bin_bounds(index, start_date, interval_length)
        length = (bin_last - bin_first).days + 1
        inside = {d for d in covered[index] if bin_first.toordinal() <= d <= bin_last.toordinal()}
        if len(inside) < MIN_BIN_COVERAGE * length:
            dropped += 1
            continue
        values = sums[index]
        mean = _circular_mean(values) if circular else sum(values) / len(values)
        if not math.isfinite(mean):
            continue
        indices.append(index)
        labels.append(bin_first.strftime("%d.%m.%Y"))
        means.append(round(mean, 3))
    if stats is not None:
        stats["dropped"] = dropped
    return indices, labels, means


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
        "source": first.get("source", "NOAA"),
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


TREND_COLOURS: dict[str, str] = {
    "rising": "#dc2626",
    "rising_weak": "#fca5a5",
    "falling": "#2563eb",
    "falling_weak": "#93c5fd",
    "flat": "#94a3b8",
}
"""Map colours: strong colour for a significant trend, pale for a non-significant one."""


def trend_colour(tool_results: dict[str, Any]) -> str:
    """Colour of a result on the map from its linear regression (or Sen's slope)."""
    for name in ("Linear Regression", "Sen's Slope"):
        result = tool_results.get(name) or {}
        slope = result.get("slope")
        if not result.get("available", True) or slope is None:
            continue
        if slope == 0:
            return TREND_COLOURS["flat"]
        key = "rising" if slope > 0 else "falling"
        return TREND_COLOURS[key if result.get("significant") else f"{key}_weak"]
    return TREND_COLOURS["flat"]


def _number(value: float | None, unit: str | None, digits: int = 3) -> str:
    if value is None:
        return "–"
    text = f"{value:.{digits}g}" if abs(value) < 1000 else f"{value:.0f}"
    return f"{text} {unit}" if unit else text


def readable_trend(tool_results: dict[str, Any], unit: str | None) -> str | None:
    """E.g. ``+1.5 °C per decade (not significant, p 0.24)``; ``None`` without a slope tool."""
    for name in ("Linear Regression", "Sen's Slope"):
        result = tool_results.get(name) or {}
        decade = result.get("slope_per_decade")
        if result.get("available", True) and decade is not None:
            sign = "+" if decade > 0 else ""
            significance = "significant" if result.get("significant") else "not significant"
            p_value = result.get("p_value")
            p_text = f", p {p_value:.3g}" if isinstance(p_value, (int, float)) else ""
            return f"{sign}{_number(decade, unit, 2)} per decade ({significance}{p_text})"
    return None


def popup_properties(
    title: str,
    mean_value: float | None,
    unit: str | None,
    count: int,
    tool_results: dict[str, Any],
    found_events: list[dict[str, Any]] | None = None,
) -> dict[str, Any]:
    """Readable properties of a result on the map (the widget lists them in its popup)."""
    properties: dict[str, Any] = {"Result": title, "Mean": _number(mean_value, unit), "Intervals": count}
    trend = readable_trend(tool_results, unit)
    if trend:
        properties["Trend"] = trend
    mann_kendall = tool_results.get("Mann-Kendall") or {}
    if mann_kendall.get("available"):
        properties["Mann-Kendall"] = f"{mann_kendall['trend']} (p {mann_kendall['p_value']:.3g})"
    change = tool_results.get("Change Point") or {}
    if change.get("available") and change.get("significant"):
        properties["Shift"] = f"{_number(change.get('shift'), unit)} around {change.get('date', change.get('x_after'))}"
    if found_events:
        top = found_events[0]
        properties["Most notable"] = f"{top['title']} on {top['date']}: {_number(top['value'], unit)}"
    return properties


def run_series_tools(
    indices: list[int],
    values: list[float],
    tool_names: list[str],
    interval_length: tuple[float, str],
    labels: list[str] | None = None,
    direction: bool = False,
) -> dict[str, Any]:
    """Run the analysis tools on a binned series (shared by point and area requests).

    ``direction``: the series is a compass direction; no tool is run.

    ``indices`` are the interval numbers from :func:`bin_records_indexed`, so
    slopes are "per interval" and respect gaps; every slope is also given per
    year and per decade.
    """
    if not tool_names:
        return {}
    if direction:
        return {
            name: {
                "available": False,
                "error": "Directions wrap around at 360°, so trend tests on them are not meaningful.",
                "observations": len(values),
            }
            for name in tool_names
        }
    import plot_analysis  # late import: plot_analysis imports this module

    per_year = INTERVAL_DAYS["Year"] / interval_step_days(interval_length)
    return plot_analysis.run_tools(indices, values, tool_names, per_year=per_year, labels=labels)


def _safe_events(records: list[dict[str, Any]], variables: list[str], unit: str | None) -> list[dict[str, Any]]:
    """Notable events of one variable's raw records (see :mod:`events`); never raises."""
    import events  # late import: events imports this module

    if variables and all(is_direction(v) for v in variables):
        return []
    try:
        return events.events_for_records(records, variables[0] if len(variables) == 1 else "", unit)
    except Exception:  # noqa: BLE001 - events are extra; the series must still be shown
        return []


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
            topic_records = _load_records_for_topic(
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
        # Each NOAA code (e.g. TMAX, TMIN, TAVG) is its own series; averaging
        # them together would mix different quantities.
        # Precipitation as a density (mm/day, % of days) so periods of any
        # length are comparable; DAPR day counts are folded into MDPR.
        topic_records = precipitation_as_density(topic_records)
        for result_key, records in drop_sparse_variables(split_by_variable(topic, topic_records)):
            station = _station_from_records(records, latitude, longitude)
            variables = sorted({str(r["description"]) for r in records if r.get("description")})
            units = {r.get("unit") for r in records}
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
                            "source": station["source"],
                            "topics": [],
                            "color": "#7c3aed",
                        },
                    },
                )
                feature["properties"]["topics"].append(result_key)
            bin_stats: dict[str, Any] = {}
            indices, labels, values = bin_records_indexed(
                records, start_date, end_date, interval_length, bin_stats
            )
            sample_count = len(values)
            tool_names = [name for name in get_available_tools() if name in selected_tools]
            tool_results = run_series_tools(
                indices, values, tool_names, interval_length, labels,
                direction=bool(variables) and all(is_direction(v) for v in variables),
            )
            mean_value = round(sum(values) / sample_count, 3) if sample_count else None
            topic_results[result_key] = {
                "labels": labels,
                "values": values,
                "mean": mean_value,
                "coordinates": [latitude, longitude],
                "station": station,
                "variables": variables,
                "unit": unit,
                "tools": tool_results,
                "events": _safe_events(records, variables, unit),
                # Intervals left out because data covered < MIN_BIN_COVERAGE of their days.
                "dropped_intervals": bin_stats.get("dropped", 0),
            }

            properties = popup_properties(
                result_key, mean_value, unit, sample_count, tool_results, topic_results[result_key]["events"]
            )
            properties["color"] = trend_colour(tool_results)

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
