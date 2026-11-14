NOAA topic catalog
==================

The NCEI Access Data Service uses dataset-specific, case-sensitive type codes.
The catalog below maps the application's topic keys to those dataset slugs and
codes. It covers the weather and climate topics currently curated in
``noaa_api.TOPICS``. NCEI exposes many additional dataset-specific types, so
this is a broad application catalog rather than a claim to enumerate every
observation across all NOAA archives.

Daily station observations
--------------------------

Dataset: ``daily-summaries`` (Global Historical Climatology Network Daily).

.. list-table::
   :header-rows: 1

   * - Topic key
     - NCEI type codes
     - What the request returns
   * - ``temperature``
     - ``TMAX``, ``TMIN``, ``TAVG``
     - Daily maximum, minimum, and average air temperature
   * - ``temperature_observation``
     - ``TOBS``
     - Temperature at station observation time
   * - ``precipitation``
     - ``PRCP``, ``MDPR``, ``DAPR``
     - Daily precipitation and multiday precipitation totals
   * - ``snowfall``
     - ``SNOW``, ``MDSF``
     - Daily and multiday snowfall totals
   * - ``snow_depth``
     - ``SNWD``
     - Snow depth
   * - ``snow_water_equivalent``
     - ``WESD``, ``WESF``
     - Water equivalent of snow on the ground and snowfall
   * - ``wind_speed``
     - ``AWND``, ``WSF1``, ``WSF2``, ``WSF5``, ``WSFG``, ``WSFI``, ``WSFM``
     - Average and fastest wind speed observations
   * - ``wind_direction``
     - ``AWDR``, ``WDF1``, ``WDF2``, ``WDF5``, ``WDFG``, ``WDFI``, ``WDFM``
     - Direction of fastest wind observations
   * - ``humidity``
     - ``RHAV``, ``RHMN``, ``RHMX``
     - Average, minimum, and maximum relative humidity
   * - ``dew_point_daily``
     - ``ADPT``
     - Average daily dew-point temperature
   * - ``pressure_daily``
     - ``ASLP``, ``ASTP``
     - Average sea-level and station pressure
   * - ``cloud_cover_daily``
     - ``ACMC``, ``ACMH``, ``ACSC``, ``ACSH``
     - Average cloudiness over day and night periods
   * - ``wet_bulb_temperature``
     - ``AWBT``
     - Average daily wet-bulb temperature
   * - ``sunshine``
     - ``PSUN``
     - Percent of possible sunshine
   * - ``soil_temperature``
     - ``SN01``–``SN36``, ``SN51``, ``SX23``–``SX83`` (selected codes)
     - Minimum/maximum soil temperature by depth and ground cover
   * - ``evaporation``
     - ``EVAP``
     - Evaporation pan total
   * - ``water_temperature``
     - ``MNPN``, ``MXPN``
     - Minimum and maximum evaporation pan water temperature
   * - ``ice_thickness``
     - ``THIC``
     - Ice thickness on water
   * - ``weather_events``
     - ``WT01``–``WT19``, ``WT21``, ``WT22``
     - Fog, thunder, hail, precipitation, dust, smoke, tornado, and other daily weather flags

Hourly station observations
---------------------------

Dataset: ``global-hourly`` (Integrated Surface Database).

.. list-table::
   :header-rows: 1

   * - Topic key
     - NCEI type codes
     - What the request returns
   * - ``temperature_hourly``
     - ``TMP``
     - Dry-bulb air temperature
   * - ``dew_point``
     - ``DEW``
     - Dew-point temperature
   * - ``relative_humidity_hourly``
     - ``RH1``
     - Relative humidity
   * - ``precipitation_hourly``
     - ``AA1``
     - Liquid precipitation accumulation
   * - ``cloud_cover``
     - ``GA1``, ``CIG``
     - Sky cover and ceiling height
   * - ``visibility``
     - ``VIS``
     - Visibility observations
   * - ``weather_observations``
     - ``AU1``, ``AW1``, ``MW1``
     - Automated and manual present weather
   * - ``wind_hourly``
     - ``WND``, ``OC1``
     - Wind and gust observations
   * - ``pressure``
     - ``MA1``, ``SLP``
     - Station pressure and sea-level pressure

Monthly and annual summaries
----------------------------

Datasets: ``global-summary-of-the-month`` and ``global-summary-of-the-year``.

.. list-table::
   :header-rows: 1

   * - Topic key
     - Dataset
     - NCEI type codes
     - What the request returns
   * - ``temperature_monthly``
     - ``global-summary-of-the-month``
     - ``TAVG``, ``TMAX``, ``TMIN``, ``EMXT``, ``EMNT``
     - Monthly mean and extreme temperatures
   * - ``precipitation_monthly``
     - ``global-summary-of-the-month``
     - ``PRCP``, ``EMXP``, ``DP01``, ``DP10``, ``DP1X``
     - Monthly/extreme precipitation and threshold-day counts
   * - ``snow_monthly``
     - ``global-summary-of-the-month``
     - ``SNOW``, ``DSNW``, ``SNWD``, ``DSND``, ``EMSN``, ``EMSD``
     - Snowfall/depth totals, extremes, and threshold-day counts
   * - ``degree_days_monthly``
     - ``global-summary-of-the-month``
     - ``HTDD``, ``CLDD``, ``HDSD``, ``CDSD``
     - Heating/cooling degree-day totals
   * - ``weather_counts_monthly``
     - ``global-summary-of-the-month``
     - ``DYFG``, ``DYHF``, ``DYTS``
     - Fog and thunderstorm day counts
   * - ``temperature_annual``
     - ``global-summary-of-the-year``
     - ``TAVG``, ``TMAX``, ``TMIN``, ``EMXT``, ``EMNT``
     - Annual mean and extreme temperatures
   * - ``precipitation_annual``
     - ``global-summary-of-the-year``
     - ``PRCP``, ``EMXP``, ``DP01``, ``DP10``, ``DP1X``
     - Annual/extreme precipitation and threshold-day counts

Marine observations
-------------------

Dataset: ``global-marine`` (ICOADS observations from ships and buoys).

.. list-table::
   :header-rows: 1

   * - Topic key
     - NCEI type codes
     - What the request returns
   * - ``marine_temperature``
     - ``AIR_TEMP``, ``SEA_SURF_TEMP``, ``DEW_PT_TEMP``
     - Air, sea-surface, and dew-point temperatures
   * - ``marine_precipitation``
     - ``AMT_PRECIP``
     - Marine precipitation amounts
   * - ``marine_wind``
     - ``WIND_DIR``, ``WIND_SPEED``, ``REL_WIND_DIR``, ``REL_WIND_SPD``
     - Absolute and relative wind direction/speed
   * - ``marine_pressure``
     - ``SEA_LVL_PRES``
     - Sea-level pressure
   * - ``marine_wet_bulb_temperature``
     - ``WET_BULB_TEMP``
     - Marine wet-bulb temperature
   * - ``marine_waves``
     - ``WAVE_DIR``, ``WAVE_HGT``, ``WAVE_PERIOD``, ``SWELL_DIR``, ``SWELL_HGT``, ``SWELL_PERIOD``
     - Wave and swell height, period, and direction
   * - ``marine_cloud_cover``
     - ``TOT_CLD_AMT``, ``LOW_CLD_AMT``
     - Total and low cloud amount
   * - ``marine_visibility``
     - ``VISIBILITY``
     - Visibility observations
   * - ``marine_sea_ice``
     - ``CONCEN_OF_SEA_ICE``, ``THICKNESS_OF_I``, ``ICE_SIT_TREND``, ``TRUE_BEARING_ICE_EDGE``
     - Sea-ice concentration, thickness, trend, and edge bearing

The API's supported dataset/type combinations can change. Check the current
NCEI dataset metadata before adding or changing a mapping. NOAA documentation:

* `Access Data Service <https://www.ncei.noaa.gov/access/search/documentation/data-service/>`_
* `Access Search Service <https://www.ncei.noaa.gov/access/search/documentation/search-service/>`_
* `Daily summaries dataset <https://www.ncei.noaa.gov/access/search/data-search/daily-summaries/>`_
* `Global Hourly dataset <https://www.ncei.noaa.gov/access/search/data-search/global-hourly/>`_
