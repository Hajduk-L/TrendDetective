"""Module defining the user request model, button model, and Python interface.

This module provides:
- :func:`parse_dd_mm_yyyy`: Strict ``DD.MM.YYYY`` date parser returning :class:`datetime.date`.
- :class:`UserRequest`: Dataclass storing selected topics, selected tools, ``timeintervall`` dates,
  ``interval_length`` tuple, and selected map ``area``.
- :class:`Button`: Dataclass binding a UI button to a single Python trigger method.
- :class:`AppInterface`: Main interface retrieving topics from :mod:`api_wrapper`,
  coordinating button triggers, and passing :class:`UserRequest` into :mod:`src.task`.
"""

from collections.abc import Callable
from dataclasses import dataclass, field
from datetime import date, datetime
from typing import Any

import api_wrapper
from src.task import get_available_tools, process_user_request

DATE_FORMAT: str = "%d.%m.%Y"
VALID_INTERVAL_UNITS: tuple[str, ...] = ("Day", "Month", "Year")


def parse_dd_mm_yyyy(date_str: str) -> date:
    """Parse a date string strictly formatted as ``DD.MM.YYYY`` into a :class:`datetime.date`.

    :param date_str: Date string in ``DD.MM.YYYY`` format (e.g. ``"14.11.2026"``).
    :type date_str: str
    :raises ValueError: If ``date_str`` does not strictly match ``DD.MM.YYYY`` or is not a valid date.
    :return: Parsed date object.
    :rtype: date
    """
    cleaned = str(date_str).strip()
    if len(cleaned) != 10 or cleaned[2] != "." or cleaned[5] != ".":
        raise ValueError(f"Date '{cleaned}' must be formatted as DD.MM.YYYY.")
    return datetime.strptime(cleaned, DATE_FORMAT).date()


@dataclass
class UserRequest:
    """Data model representing the user's filtered topic, tool, timeintervall, interval, and area selection.

    Created when the user clicks the 'Apply' button in the web interface and passed
    into :func:`src.task.process_user_request`.

    :param topics: Dictionary mapping each topic name to ``True`` if checked,
        or ``False`` otherwise.
    :type topics: dict[str, bool]
    :param tools: Dictionary mapping each analysis tool name (e.g. ``"Linear Regression"``,
        ``"t-Test"``) to ``True`` if checked, or ``False`` otherwise.
    :type tools: dict[str, bool]
    :param timeintervall: Tuple of ``(start_date, end_date)`` as :class:`datetime.date`
        objects parsed from the two ``DD.MM.YYYY`` brackets.
    :type timeintervall: tuple[date, date]
    :param interval_length: Tuple of ``(value, unit)`` where ``value`` is a ``float``
        strictly greater than ``0`` and ``unit`` is ``"Day"``, ``"Month"``, or ``"Year"``.
    :type interval_length: tuple[float, str]
    :param area: Area drawn on the map widget as a GeoJSON Feature, or ``None`` if no area is selected.
    :type area: dict[str, Any] | None
    """

    topics: dict[str, bool]
    tools: dict[str, bool]
    timeintervall: tuple[date, date]
    interval_length: tuple[float, str] = (1.0, "Day")
    area: dict[str, Any] | None = None

    def __post_init__(self) -> None:
        """Validate the timeintervall dates and interval length after initialization.

        :raises AssertionError: If ``timeintervall`` does not contain two :class:`datetime.date`
            instances, if the interval float value is not strictly greater than ``0``,
            or if the unit is not one of ``"Day"``, ``"Month"``, or ``"Year"``.
        :return: None
        :rtype: None
        """
        start_date, end_date = self.timeintervall
        assert isinstance(start_date, date) and isinstance(end_date, date), (
            "timeintervall must be a tuple of two datetime.date objects."
        )
        assert end_date >= start_date, (
            "End date must be on or after start date."
        )

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

        :return: Dictionary containing ``topics``, ``tools``, ``timeintervall``,
            ``interval_length``, and ``area``.
        :rtype: dict[str, Any]
        """
        return {
            "topics": self.topics,
            "tools": self.tools,
            "timeintervall": [
                self.timeintervall[0].strftime(DATE_FORMAT),
                self.timeintervall[1].strftime(DATE_FORMAT),
            ],
            "timeintervall_repr": [
                repr(self.timeintervall[0]),
                repr(self.timeintervall[1]),
            ],
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
    """Python interface managing topics from :mod:`api_wrapper`, tools from :mod:`src.task`, buttons, and user requests.

    Each button registered in this interface is connected to one method via
    :meth:`Button.set_trigger`.

    :param buttons: Mapping of button IDs to their corresponding :class:`Button` instances.
    :type buttons: dict[str, Button]
    :param topic_states: Current checked/unchecked state for each topic.
    :type topic_states: dict[str, bool]
    :param tool_states: Current checked/unchecked state for each statistical tool.
    :type tool_states: dict[str, bool]
    :param timeintervall: Current ``(start_date, end_date)`` date objects from the UI brackets.
    :type timeintervall: tuple[date, date] | None
    :param interval_length: Current ``(value, unit)`` interval length tuple from the UI.
    :type interval_length: tuple[float, str]
    :param area: Currently selected GeoJSON Feature from the map widget, or ``None``.
    :type area: dict[str, Any] | None
    :param last_user_request: Most recent :class:`UserRequest` created when 'Apply' was clicked.
    :type last_user_request: UserRequest | None
    :param last_task_results: Visualization and statistical output produced by :mod:`src.task`.
    :type last_task_results: dict[str, Any] | None
    """

    buttons: dict[str, Button] = field(default_factory=dict, init=False)
    topic_states: dict[str, bool] = field(default_factory=dict, init=False)
    tool_states: dict[str, bool] = field(default_factory=dict, init=False)
    timeintervall: tuple[date, date] | None = field(default=None, init=False)
    interval_length: tuple[float, str] = field(default=(1.0, "Day"), init=False)
    area: dict[str, Any] | None = field(default=None, init=False)
    last_user_request: UserRequest | None = field(default=None, init=False)
    last_task_results: dict[str, Any] | None = field(default=None, init=False)

    def __post_init__(self) -> None:
        """Initialize and register buttons with their trigger methods.

        :return: None
        :rtype: None
        """
        apply_button = Button(button_id="apply", label="Apply")
        apply_button.set_trigger(self.on_apply)
        self.register_button(apply_button)

    def get_sorted_topics(self) -> list[str]:
        """Retrieve all topics from :func:`api_wrapper.get_all_topics_list` sorted alphabetically.

        :return: Alphabetically sorted list of topic names from :mod:`api_wrapper`.
        :rtype: list[str]
        """
        topics = api_wrapper.get_all_topics_list()
        return sorted(topics, key=str.lower)

    def get_sorted_tools(self) -> list[str]:
        """Retrieve all statistical analysis tools from :func:`src.task.get_available_tools`.

        :return: Alphabetically sorted list of tool names (``["Linear Regression", "t-Test"]``).
        :rtype: list[str]
        """
        return get_available_tools()

    def set_request_inputs(
        self,
        states: dict[str, bool],
        tools: dict[str, bool],
        timeintervall: tuple[str, str],
        interval_length: tuple[float, str],
        area: dict[str, Any] | None = None,
    ) -> None:
        """Update the current topic selection, tool selection, timeintervall dates, interval length, and map area.

        Parses both strings in ``timeintervall`` strictly using ``DD.MM.YYYY`` into
        :class:`datetime.date` objects.

        :param states: Mapping of topic names to their checked boolean state.
        :type states: dict[str, bool]
        :param tools: Mapping of tool names to their checked boolean state.
        :type tools: dict[str, bool]
        :param timeintervall: Tuple of ``(start_str, end_str)`` formatted as ``DD.MM.YYYY``.
        :type timeintervall: tuple[str, str]
        :param interval_length: Tuple of ``(float_value, unit)`` where ``float_value > 0``
            and ``unit`` is ``"Day"``, ``"Month"``, or ``"Year"``.
        :type interval_length: tuple[float, str]
        :param area: Selected GeoJSON Feature from the map widget, or ``None``.
        :type area: dict[str, Any] | None
        :raises ValueError: If either date in ``timeintervall`` is not formatted as ``DD.MM.YYYY``
            or if ``end_date < start_date``.
        :raises AssertionError: If ``interval_length[0] <= 0`` or ``interval_length[1]``
            is not a valid unit.
        :return: None
        :rtype: None
        """
        sorted_topics = self.get_sorted_topics()
        self.topic_states = {
            topic: bool(states.get(topic, False)) for topic in sorted_topics
        }

        sorted_tools = self.get_sorted_tools()
        self.tool_states = {
            tool: bool(tools.get(tool, False)) for tool in sorted_tools
        }

        start_date = parse_dd_mm_yyyy(timeintervall[0])
        end_date = parse_dd_mm_yyyy(timeintervall[1])
        if end_date < start_date:
            raise ValueError("End date must be on or after start date.")
        self.timeintervall = (start_date, end_date)

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
        """Create a :class:`UserRequest` and execute :func:`src.task.process_user_request` on 'Apply'.

        Requires at least one topic to be checked (``True``), ``timeintervall`` to
        contain two valid :class:`datetime.date` objects, and the interval length
        float to be strictly greater than ``0``. Stores the created
        :class:`UserRequest` on ``self.last_user_request`` and stores the computed
        task and visualization results on ``self.last_task_results``.

        :raises ValueError: If no topic is selected or ``timeintervall`` is missing.
        :raises AssertionError: If the interval length value is not greater than ``0``.
        :return: None
        :rtype: None
        """
        sorted_topics = self.get_sorted_topics()
        request_topics = {
            topic: bool(self.topic_states.get(topic, False))
            for topic in sorted_topics
        }
        if not any(request_topics.values()):
            raise ValueError("At least one topic must be selected.")
        if self.timeintervall is None:
            raise ValueError("Both timeintervall dates must be filled as DD.MM.YYYY.")
        assert self.interval_length[0] > 0, (
            "Interval length value must be greater than 0."
        )

        sorted_tools = self.get_sorted_tools()
        request_tools = {
            tool: bool(self.tool_states.get(tool, False))
            for tool in sorted_tools
        }

        self.last_user_request = UserRequest(
            topics=request_topics,
            tools=request_tools,
            timeintervall=self.timeintervall,
            interval_length=self.interval_length,
            area=self.area,
        )
        self.last_task_results = process_user_request(self.last_user_request)
        print(f"Created UserRequest: {self.last_user_request}")
