TrendDetective documentation
============================

TrendDetective retrieves environmental observations for a selected topic,
coordinate, and inclusive date range. Its API wrapper keeps the application
interface independent of individual data providers.

.. toctree::
   :maxdepth: 2
   :caption: Contents

   api
   noaa-topics

Quick start
-----------

Create a :class:`api_wrapper.PointDataRequest` using ``datetime.date`` values,
then pass it to :func:`api_wrapper.fetch_data_single_topic_single_coordinate`.
The NOAA NCEI Access Data Service does not need a token. NOAA JSON results are
saved under ``data/noaa/`` by default. Additional API clients can be registered
in the provider-neutral wrapper as the project grows.
