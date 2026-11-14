"""Module defining the mock data source, user request model, button model, and Python interface.

This module provides:
- :class:`marten`: Mock class supplying dataset topics via :meth:`marten.getTopics`.
- :class:`UserRequest`: Dataclass storing selected topics, timestamp range, and interval length tuple.
- :class:`Button`: Dataclass binding a UI button to a single Python trigger method.
- :class:`AppInterface`: Main interface coordinating topics, button triggers, and user requests.
"""

from collections.abc import Callable
from dataclasses import dataclass, field
from typing import Any

VALID_INTERVAL_UNITS: tuple[str, ...] = ("Day", "Month", "Year")


@dataclass
class marten:
    """Mock data source class providing available dataset topics.

    This class is a placeholder for the external data provider class that will
    supply dataset variables in later stages of the project.
    """

    def getTopics(self) -> list[str]:
        """Return all available variable topics from the dataset.

        :return: List of dataset topic names.
        :rtype: list[str]
        """
        return [
            "Temperature",
            "Windvelocity",
            "Precipitation",
            "TMP",
            "Another Thing",
            "not Another Thing",
        ]


@dataclass
class UserRequest:
    """Data model representing the user's filtered topic, timestamp, and interval selection.

    Created when the user clicks the 'Apply' button in the web interface.

    :param topics: Dictionary mapping each topic name to ``True`` if checked,
        or ``False`` otherwise.
    :type topics: dict[str, bool]
    :param timestamp: Tuple of ``(start_timestamp, end_timestamp)`` strings entered
        in the two timestamp brackets.
    :type timestamp: tuple[str, str]
    :param interval_length: Tuple of ``(value, unit)`` where ``value`` is a ``float``
        strictly greater than ``0`` and ``unit`` is ``"Day"``, ``"Month"``, or ``"Year"``.
    :type interval_length: tuple[float, str]
    :param area: Area drawn on the map widget as a GeoJSON Feature (Polygon, ``[lng, lat]``,
        with ``bbox`` = ``[west, south, east, north]``), or ``None`` if no area is selected.
        See ``map-widget/API.md``.
    :type area: dict[str, Any] | None
    """

    topics: dict[str, bool]
    timestamp: tuple[str, str] = ("", "")
    interval_length: tuple[float, str] = (1.0, "Day")
    area: dict[str, Any] | None = None

    def __post_init__(self) -> None:
        """Validate the interval length value and unit after initialization.

        :raises AssertionError: If the interval float value is not strictly greater
            than ``0`` or the unit is not one of ``"Day"``, ``"Month"``, or ``"Year"``.
        :return: None
        :rtype: None
        """
        value, unit = self.interval_length
        assert isinstance(value, (int, float)) and float(value) > 0, (
            "Interval length value must be a float greater than 0."
        )
        assert unit in VALID_INTERVAL_UNITS, (
            f"Interval unit must be one of {VALID_INTERVAL_UNITS}."
        )
        self.interval_length = (float(value), unit)

    def to_dict(self) -> dict[str, Any]:
        """Serialize the user request into a JSON-compatible dictionary.

        :return: Dictionary containing ``topics``, ``timestamp``, ``interval_length``, and ``area``.
        :rtype: dict[str, Any]
        """
        return {
            "topics": self.topics,
            "timestamp": list(self.timestamp),
            "interval_length": [self.interval_length[0], self.interval_length[1]],
            "area": self.area,
        }


@dataclass
class Button:
    """Data model representing a single UI button bound to one Python method.

    :param button_id: Unique identifier matching the HTML button ``id``.
    :type button_id: str
    :param label: Display text shown on the button in the web interface.
    :type label: str
    :param handler: The single callable method executed when the button is clicked.
    :type handler: Callable[[], None] | None
    """

    button_id: str
    label: str = ""
    handler: Callable[[], None] | None = None

    def set_trigger(self, handler: Callable[[], None]) -> None:
        """Assign the single trigger method to be executed when this button is clicked.

        :param handler: Callable method taking no arguments and returning ``None``.
        :type handler: Callable[[], None]
        :return: None
        :rtype: None
        """
        self.handler = handler

    def trigger(self) -> None:
        """Execute the trigger method associated with this button.

        :raises RuntimeError: If no trigger method has been assigned via :meth:`set_trigger`.
        :return: None
        :rtype: None
        """
        if self.handler is None:
            raise RuntimeError(
                f"Button '{self.button_id}' does not have a trigger method set."
            )
        self.handler()

    def to_metadata(self) -> dict[str, str]:
        """Serialize the public metadata of the button for the frontend.

        :return: Dictionary containing the button's ID and display label.
        :rtype: dict[str, str]
        """
        return {
            "button_id": self.button_id,
            "label": self.label,
        }


@dataclass
class AppInterface:
    """Python interface managing topics, timestamps, interval length, buttons, and user requests.

    Each button registered in this interface is connected to one method via
    :meth:`Button.set_trigger`.

    :param data_source: Instance of :class:`marten` used to retrieve topics.
    :type data_source: marten
    :param buttons: Mapping of button IDs to their corresponding :class:`Button` instances.
    :type buttons: dict[str, Button]
    :param topic_states: Current checked/unchecked state for each topic.
    :type topic_states: dict[str, bool]
    :param timestamp: Current ``(start, end)`` timestamp values from the UI brackets.
    :type timestamp: tuple[str, str]
    :param interval_length: Current ``(value, unit)`` interval length tuple from the UI.
    :type interval_length: tuple[float, str]
    :param area: Current map area (GeoJSON Feature) from the map widget, or ``None``.
    :type area: dict[str, Any] | None
    :param last_user_request: Most recent :class:`UserRequest` created when 'Apply' was clicked.
    :type last_user_request: UserRequest | None
    """

    data_source: marten = field(default_factory=marten)
    buttons: dict[str, Button] = field(default_factory=dict, init=False)
    topic_states: dict[str, bool] = field(default_factory=dict, init=False)
    timestamp: tuple[str, str] = field(default=("", ""), init=False)
    interval_length: tuple[float, str] = field(default=(1.0, "Day"), init=False)
    area: dict[str, Any] | None = field(default=None, init=False)
    last_user_request: UserRequest | None = field(default=None, init=False)

    def __post_init__(self) -> None:
        """Initialize and register buttons with their trigger methods.

        :return: None
        :rtype: None
        """
        apply_button = Button(button_id="apply", label="Apply")
        apply_button.set_trigger(self.on_apply)
        self.register_button(apply_button)

    def get_sorted_topics(self) -> list[str]:
        """Retrieve all topics from ``marten.getTopics()`` sorted alphabetically.

        :return: Alphabetically sorted list of topic names.
        :rtype: list[str]
        """
        topics = self.data_source.getTopics()
        return sorted(topics, key=str.lower)

    def set_request_inputs(
        self,
        states: dict[str, bool],
        timestamp: tuple[str, str],
        interval_length: tuple[float, str],
        area: dict[str, Any] | None = None,
    ) -> None:
        """Update the current topic selection, timestamp brackets, interval length, and map area.

        :param states: Mapping of topic names to their checked boolean state.
        :type states: dict[str, bool]
        :param timestamp: Tuple of ``(start_timestamp, end_timestamp)`` strings.
        :type timestamp: tuple[str, str]
        :param interval_length: Tuple of ``(float_value, unit)`` where ``float_value > 0``
            and ``unit`` is ``"Day"``, ``"Month"``, or ``"Year"``.
        :type interval_length: tuple[float, str]
        :param area: GeoJSON Feature of the area drawn on the map, or ``None``.
        :type area: dict[str, Any] | None
        :raises AssertionError: If ``interval_length[0] <= 0`` or ``interval_length[1]``
            is not a valid unit.
        :return: None
        :rtype: None
        """
        sorted_topics = self.get_sorted_topics()
        self.topic_states = {
            topic: bool(states.get(topic, False)) for topic in sorted_topics
        }
        self.timestamp = (str(timestamp[0]).strip(), str(timestamp[1]).strip())

        interval_val = float(interval_length[0])
        interval_unit = str(interval_length[1]).strip()
        assert interval_val > 0, "Interval length value must be greater than 0."
        assert interval_unit in VALID_INTERVAL_UNITS, (
            f"Interval unit must be one of {VALID_INTERVAL_UNITS}."
        )
        self.interval_length = (interval_val, interval_unit)
        self.area = area

    def register_button(self, button: Button) -> None:
        """Register a button instance in the interface.

        :param button: The button instance to register.
        :type button: Button
        :raises ValueError: If a button with the same ID is already registered.
        :return: None
        :rtype: None
        """
        if button.button_id in self.buttons:
            raise ValueError(f"Button '{button.button_id}' is already registered.")
        self.buttons[button.button_id] = button

    def get_buttons_metadata(self) -> list[dict[str, str]]:
        """Return serialized metadata for all registered buttons.

        :return: List of dictionaries containing each button's ID and label.
        :rtype: list[dict[str, str]]
        """
        return [button.to_metadata() for button in self.buttons.values()]

    def trigger_button(self, button_id: str) -> None:
        """Invoke the trigger method connected to the specified button ID.

        :param button_id: Unique identifier of the clicked button.
        :type button_id: str
        :raises KeyError: If no button matches the given ``button_id``.
        :return: None
        :rtype: None
        """
        if button_id not in self.buttons:
            raise KeyError(f"Unknown button ID: '{button_id}'")
        self.buttons[button_id].trigger()

    def on_apply(self) -> None:
        """Create a :class:`UserRequest` when 'Apply' is clicked if validation passes.

        Requires at least one topic to be checked (``True``), both timestamp
        brackets to be non-empty, and the interval length float to be strictly
        greater than ``0``. Does not return anything; stores the created
        :class:`UserRequest` on ``self.last_user_request``.

        :raises ValueError: If no topic is selected or either timestamp bracket is empty.
        :raises AssertionError: If the interval length value is not greater than ``0``.
        :return: None
        :rtype: None
        """
        sorted_topics = self.get_sorted_topics()
        request_dict = {
            topic: bool(self.topic_states.get(topic, False))
            for topic in sorted_topics
        }
        if not any(request_dict.values()):
            raise ValueError("At least one topic must be selected.")
        if not self.timestamp[0] or not self.timestamp[1]:
            raise ValueError("Both timestamp brackets must be filled.")
        assert self.interval_length[0] > 0, (
            "Interval length value must be greater than 0."
        )

        self.last_user_request = UserRequest(
            topics=request_dict,
            timestamp=self.timestamp,
            interval_length=self.interval_length,
            area=self.area,
        )
        print(f"Created UserRequest: {self.last_user_request}")
