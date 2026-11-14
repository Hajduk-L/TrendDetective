from dataclasses import dataclass
from typing import Any

from scipy import stats as scipy_stats
import torch
from scipy import stats

import api_wrapper

@dataclass(frozen=True)
class TrendAnalysis:
    """Summary statistics for a linear trend in a time series.

    ``slope`` is the estimated change in the values per unit of time. The
    p-value tests the two-sided null hypothesis that the slope is zero.
    """

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


def mann_kendall_test(
    time: list[float] | tuple[float, ...] | torch.Tensor,
    values: list[float] | tuple[float, ...] | torch.Tensor,
    alpha: float = 0.05,
) -> MannKendallResult:
    """Test for a monotonic trend, accounting for ties in the observed values.

    Observations are ordered by ``time``. The p-value is a two-sided,
    continuity-corrected normal approximation with tie-corrected variance.
    The standard test assumes independent observations; serial correlation
    can affect its significance estimate.

    :param time: Numeric, unique time coordinates.
    :param values: Finite observations corresponding to ``time``.
    :param alpha: Significance threshold used to label the detected trend.
    :raises ValueError: If inputs are invalid or do not contain at least three observations.
    :return: Mann-Kendall S, Z, Kendall's tau, p-value, and trend direction.
    """
    def as_vector(
        data: list[float] | tuple[float, ...] | torch.Tensor, name: str
    ) -> torch.Tensor:
        vector = torch.as_tensor(data, dtype=torch.float64).detach().cpu()
        if vector.ndim != 1:
            raise ValueError(f"{name} must be a one-dimensional sequence.")
        return vector

    x = as_vector(time, "time")
    y = as_vector(values, "values")
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
        (ordered_values[j] > ordered_values[i]) - (ordered_values[j] < ordered_values[i])
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
            z_statistic = (s_statistic - 1) / variance**0.5
        elif s_statistic < 0:
            z_statistic = (s_statistic + 1) / variance**0.5
        else:
            z_statistic = 0.0
        p_value = float(2 * stats.norm.sf(abs(z_statistic)))

    untied_pairs = n * (n - 1) / 2
    value_tied_pairs = sum(count * (count - 1) / 2 for count in tie_counts)
    tau_denominator = (untied_pairs * (untied_pairs - value_tied_pairs)) ** 0.5
    tau = s_statistic / tau_denominator if tau_denominator else 0.0
    trend = (
        "increasing" if p_value < alpha and s_statistic > 0
        else "decreasing" if p_value < alpha and s_statistic < 0
        else "no significant trend"
    )

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


class LinearRegression:
    """Linear regression task."""

    def train(self, X: torch.Tensor, y: torch.Tensor):
        """Return tuple of weight and bias for linear regression model for given dataset."""
        X_b = torch.cat([X, torch.ones(X.shape[0], 1)], dim=1)
        solution = torch.linalg.lstsq(X_b, y).solution
        w = solution[0]
        b = solution[1]
        return (w, b)

    def analyze_trend(
        self,
        time: list[float] | tuple[float, ...] | torch.Tensor,
        values: list[float] | tuple[float, ...] | torch.Tensor,
        confidence_level: float = 0.95,
    ) -> TrendAnalysis:
        """Estimate a linear time trend and test whether its slope differs from zero.

        The returned slope is the rate of change in ``values`` per unit of
        ``time``. The t-test is two-sided and uses the OLS slope standard error
        with ``n - 2`` degrees of freedom. Both inputs must be finite,
        one-dimensional paired observations, with at least two distinct time
        points overall. Missing values should be handled by the caller before
        analysis.

        :param time: Numeric time coordinates, such as elapsed days or years.
        :param values: Observed time-series values corresponding to ``time``.
        :param confidence_level: Confidence level for the slope interval, between 0 and 1.
        :raises ValueError: If inputs are mismatched, too short, non-finite, or invalid.
        :return: Slope, significance test, and confidence interval summary.
        """
        def as_vector(
            data: list[float] | tuple[float, ...] | torch.Tensor, name: str
        ) -> torch.Tensor:
            vector = torch.as_tensor(data, dtype=torch.float64).detach().cpu()
            if vector.ndim != 1:
                raise ValueError(f"{name} must be a one-dimensional sequence.")
            return vector

        x = as_vector(time, "time")
        y = as_vector(values, "values")
        if x.numel() != y.numel():
            raise ValueError(
                "time and values must contain the same number of observations."
            )
        if x.numel() < 3:
            raise ValueError(
                "At least three observations are required for a trend t-test."
            )
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
        t_statistic = (
            regression.slope / regression.stderr
            if regression.stderr > 0
            else (
                float("inf")
                if regression.slope > 0
                else float("-inf")
                if regression.slope < 0
                else 0.0
            )
        )

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
