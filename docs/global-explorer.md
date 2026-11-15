# Global Explorer – Analyse & Konzept (Branch `global-explorer`)

Dieser Branch ist ein **Gegenentwurf** zur bisherigen stationsbasierten Analyse: Statt für
einen Punkt oder eine Region Messwerte bei Wetterdiensten abzufragen, arbeitet der Global
Explorer mit einem **globalen, gerasterten Datensatz** und kann deshalb jede Region der Welt
in Sekundenbruchteilen auswerten und mit jeder anderen vergleichen – zum Beispiel
Mittelmeer vs. Antarktis vs. Südpazifik vs. NRW.

Start: `python3 app.py` → <http://127.0.0.1:8000/explorer/>. Die bisherige Seite unter `/`
bleibt unverändert nutzbar (oben links gibt es jetzt einen Link „🌍 Global Explorer“).
Beim ersten Aufruf lädt der Server den GISTEMP-Datensatz (~26 MB) nach `data/cache/gistemp/`,
beim ersten Umschalten auf Niederschlag GPCP (~21 MB, ca. 1 Minute) nach `data/cache/gpcp/`.

---

## 1. Analyse des bisherigen Projekts (Stand `main` @ ba21327)

**Architektur.** `app.py` (Standardbibliothek-HTTP-Server) liefert `index.html` mit dem
React/MapLibre-Karten-Widget (`map-widget/`) und dem Plot-Panel (`static/plots/plots.js`).
„Apply“ streamt pro Thema Ergebnisse (`/api/buttons/apply/stream`, NDJSON). Ein Punkt geht
über `src/task.py` (nächste Station), eine der 22 vordefinierten Regionen über
`area_analysis.py` (bis 40 Stationen, Anomalien je Station gemittelt).

**Datenquellen** (alle ohne Schlüssel): NOAA NCEI (weltweit, ~43 Themen inkl. stündlich und
Marine), DWD (Deutschland), ECCC (Kanada), FMI (Finnland), Open-Meteo ERA5 (Modell, Punkt
bzw. 3×3-Stichprobe einer Region), PolarWatch (Eisdicke ab 2021). Stationen mehrerer Quellen
werden über WMO-/GHCN-IDs bzw. Position dedupliziert.

**Analysen.** Lineare Regression, Mann-Kendall, Welch-t-Test (erste gegen zweite Hälfte);
im Plot-Panel zusätzlich Ansichten „Timeline“, „Years overlaid“, „Period across years“,
gleitendes Mittel, Anomalie, Analysefenster je Monat/Saison/Jahr, CSV-Export.
`/api/coverage` zeigt, wann Stationen einer Auswahl Daten haben.

**Stärken.** Echte Stationsmessungen mit hoher zeitlicher Auflösung (täglich/stündlich),
viele Variablen (Niederschlag, Schnee, Wind, Meer), nachvollziehbare Herkunft jedes Werts,
saubere Tests für Quellen und Region-Auswertung.

**Grenzen in Bezug auf die Challenge** („globale Veränderungen darstellen und vergleichen“):

| Thema | Beobachtung |
|---|---|
| Globaler Überblick | Es gibt keine Weltkarte der Veränderung – man sieht immer nur einen Punkt oder eine Region. |
| Regionen | Nur Punkt oder 22 feste Boxen (überwiegend USA/Europa); keine freien Regionen, keine Ozeane/Pole als Ganzes. |
| Vergleich | Regionen lassen sich nicht nebeneinander vergleichen; Ergebnisse sind Karten pro Thema. |
| Geschwindigkeit | Mehrjährige Abfragen laufen live gegen NOAA & Co. (max. 3 parallele Anfragen, Timeouts, Marine besonders langsam). |
| Methodik | Punkt-Regression ohne p-Wert und auf Indexachse (Lücken stauchen die Zeit, siehe Gap G8); keine Autokorrelations-Korrektur; Regionen mitteln Stationen ohne Flächengewichtung. |
| Datenlage | Antarktis, Ozeane, Afrika haben kaum Stationen → genau dort, wo globale Vergleiche spannend sind, fehlen Daten. |

## 2. Idee des Global Explorers

1. **Globale Gitterdatensätze statt Einzelabfragen** – umschaltbar oben in der Leiste:
   * **Temperatur: NASA GISTEMP v4** – monatliche Anomalien der Oberflächentemperatur,
     2°×2°, seit 1880 (Land: GHCNv4-Stationen, Meer: ERSSTv5).
   * **Niederschlag: GPCP v2.3** – monatlicher Niederschlag, 2,5°×2,5°, seit 1979
     (Satelliten + Regenmesser), als Anomalie zum Klimamittel 1991–2020; zusätzlich
     relative Trends in % pro Dekade.

   Je ein Download, danach ist jede Auswertung lokal und schnell (Karte ~0,2 s, Regionen ~0,1 s).
2. **Karte zuerst** – ein Globus, auf dem die Veränderung als farbiges Overlay liegt.
3. **Beliebige Regionen vergleichen** – vordefiniert (26 Regionen inkl. Mittelmeer, Arktis,
   Antarktis, Südpazifik, Niño-3.4, NRW …), per Suche (Ort/Land über Nominatim), als
   gezeichnetes Rechteck oder als einzelne Gitterzelle per Klick. Bis zu 8 gleichzeitig.
4. **Wissenschaftliche Methodik, offen erklärt** (Dialog „Methodik“ in der App).

## 3. Funktionen

### Bedienkonzept (seit der Überarbeitung)
Die Karte steht im Mittelpunkt, alles andere schwebt klein darüber und lässt sich einklappen:

* **Links – Ansicht:** zwei Hauptansichten, alles Weitere unter „Mehr“.
  * **Zeitreise** (Start): Abweichung jedes Jahres – oder jedes **Monats** – vom gewählten
    Vergleichszeitraum. „Vergleich mit“ (1951–1980, 1991–2020 = heutiges Klima, 1880–1900 …)
    liegt direkt sichtbar daneben, weil er bestimmt, wie „rot“ die Welt aussieht.
  * **Trend**: Erwärmungs- bzw. Niederschlagstrend im Zeitraum (Schnellwahl + Jahresfelder).
  * **Mehr ▾**: Mittlere Abweichung, Beschleunigung, Signal/Rauschen, räumlicher Gradient,
    beim Niederschlag zusätzlich der relative Trend.
  * Jahreszeit und Darstellungsoptionen liegen unter „Einstellungen“.
* **Oben Mitte – Zeitanzeige:** groß das gezeigte Jahr („2024“) bzw. der Monat („Juli 2023“)
  oder der Zeitraum, darunter das globale Mittel.
* **Unten – Zeitleiste:** Die Spur zeigt die Geschichte des **gerade sichtbaren
  Kartenausschnitts** als Klimastreifen mit Kurve. In der Zeitreise zieht man den Griff durch
  die Jahre/Monate, ▶ spielt den Zeitraffer (Tempo 0,5–4×, Leertaste, ← →). In den Trend-Ansichten
  hat die Leiste zwei Griffe für den Zeitraum und zeigt die Trendgerade des Ausschnitts.
  Rechts steht der Wert des Ausschnitts; ⊕ übernimmt den Ausschnitt als Region.
  Zoomen und Abspielen ergibt so „dieses Gebiet im Zeitraffer“.
* **Rechts – Regionen:** Suche, ▭ Zeichnen, Liste der Auswahl; vordefinierte Regionen sind
  unter „Vorschläge“ eingeklappt. Es ist **nichts vorausgewählt**; mit der ersten Region
  öffnet sich der Analysebereich unten.
* **Farbskala Temperatur:** Navy → Blau → hell → Gelb → Orange → Rot → Pflaume. Die warme Hälfte
  wechselt den Farbton statt nur dunkler zu werden, damit +0,5 °C und +2,5 °C unterscheidbar
  bleiben. In der Zeitreise ist die Skala über alle Jahre fest (sonst wäre der Zeitraffer
  irreführend).

### Kartenebenen
| Ebene | Bedeutung |
|---|---|
| Zeitreise | Abweichung jedes Jahres oder Monats vom Vergleichszeitraum, als Zeitraffer 1880 → heute |
| Trend | OLS-Trend je Zelle in °C/Dekade; Punkte = nicht signifikant (p ≥ 0,05, AR(1)-korrigiert) |
| Mittlere Abweichung | Mittlere Abweichung im Zeitraum ggü. Referenzperiode |
| Beschleunigung | Trend 2. Hälfte − Trend 1. Hälfte („zweite Ableitung“) |
| Signal/Rauschen | Änderung im Zeitraum / Jahr-zu-Jahr-Schwankung |
| Räuml. Gradient | Betrag des räumlichen Gradienten des Trendfelds (°C/Dekade pro 1000 km) |

Monatskarten werden in Zehnjahresstücken nachgeladen (`frames?res=monthly`, gzip, ≈ 2 MB je
Jahrzehnt) und beim Abspielen vorab geholt. Hover zeigt den Wert jeder Zelle, Klick öffnet ein
Popup mit Mini-Zeitreihe und Kennzahlen.

**Interpolation ohne erfundene Daten:** Werte gehören zu Zellmittelpunkten; die Darstellung
interpoliert bilinear zwischen den vier Nachbarn. Fehlen Nachbarn, wird nur über vorhandene
Werte gemittelt und nicht in Datenlücken hinein extrapoliert. Leere Zellen bleiben leer.

### Analyse-Tabs (unten)
| Tab | Inhalt |
|---|---|
| Zeitreihe | Jahreswerte, 11-Jahres-Mittel, linearer Trend; Tooltip mit Flächenabdeckung |
| Erwärmungstempo | gleitender 30-Jahres-Trend je Region mit 95-%-Band – zeigt, ob die Erwärmung schneller wird |
| Wärmestreifen | „Warming Stripes“ aller Regionen auf gemeinsamer Farbskala |
| Jahreszeiten | Trend je Kalendermonat mit Konfidenzintervall |
| Extreme | Verschiebung der Verteilung standardisierter Anomalien (nach Hansen et al. 2012): Anteil > 2σ / > 3σ je Zeitraum |
| Statistik | Kennzahlen, automatisch formulierte Kurzaussage, Tabelle (OLS ± KI, p, Theil-Sen, Mann-Kendall, Beschleunigung, S/N, Zeitpunkt des Hervortretens, wärmste Jahre, Fläche) |
| Ranking | alle vordefinierten Regionen nach Trend, mit KI und Faktor ggü. global; Klick fügt hinzu |
| Breitengrade | Hovmöller-Diagramm (Zonalmittel × Jahr) – zeigt z. B. die arktische Verstärkung |

**Diagramme direkt in der Karte:** Jede gewählte Region bekommt auf dem Globus eine kleine
Karte mit Sparkline (Jahreswerte + 11-Jahres-Mittel) und Trend, verbunden mit einer Linie zur
Region. Die Karten weichen einander und den Bedienfeldern aus und verschwinden hinter dem
Horizont des Globus. Klick → Statistik.

Weitere: CSV-Export der Regionszeitreihen, „Link teilen“ (kompletter Zustand in der URL),
verstellbare Höhe des Analysebereichs, Handy-Layout, Tastatur in der Zeitreise
(← → Jahr/Monat, Leertaste = Abspielen).

## 4. Demo-Pfad (für den Pitch, ca. 3 Minuten)

Alle Links setzen den kompletten Zustand (Server lokal auf Port 8000):

1. **Die Welt erwärmt sich ungleich** – Trendkarte 1979–2025, Punkte = nicht signifikant:
   <http://127.0.0.1:8000/explorer/#k=trend&p=1979-2025&s=annual&b=1951-1980>
2. **146 Jahre im Zeitraffer** – Zeitreise, ▶ drücken (dann auf Europa zoomen und erneut
   abspielen – die Zeitleiste zeigt nun Europas Klimastreifen):
   <http://127.0.0.1:8000/explorer/#k=year&y=1880&s=annual&b=1951-1980>
   Monatsweise, z. B. der Hitzesommer 2003: <http://127.0.0.1:8000/explorer/#k=year&m=1&y=2003-08&b=1991-2020>
3. **Mittelmeer vs. Antarktis vs. Südpazifik vs. NRW** – Zeitreihe, dann „Statistik“
   (Kurzfazit + Faktor ggü. global):
   <http://127.0.0.1:8000/explorer/#k=trend&p=1979-2025&s=annual&b=1951-1980&r=mediterranean|antarctica|south_pacific|nrw&t=stats>
4. **Wird es schneller?** – „Erwärmungstempo“ (gleitender 30-Jahres-Trend):
   <http://127.0.0.1:8000/explorer/#k=acceleration&p=1979-2025&s=annual&b=1951-1980&r=mediterranean|arctic|nrw|global&t=tempo>
5. **Wer erwärmt sich am schnellsten?** – Ranking aller Regionen:
   <http://127.0.0.1:8000/explorer/#k=trend&p=1979-2025&s=annual&b=1951-1980&t=ranking>
6. **Arktische Verstärkung** – Hovmöller-Diagramm „Breitengrade“:
   <http://127.0.0.1:8000/explorer/#k=trend&p=1979-2025&s=annual&b=1951-1980&r=arctic|antarctica&t=zonal>
7. **Hitzesommer werden normal** – „Extreme“, Sommer (JJA), Deutschland & Mittelmeer:
   <http://127.0.0.1:8000/explorer/#k=anomaly&p=1979-2025&s=JJA&b=1951-1980&r=germany|mediterranean&t=dist>
8. **Und der Regen?** – Niederschlag, relativer Trend:
   <http://127.0.0.1:8000/explorer/#d=gpcp&k=trend_rel&p=1979-2025&s=annual&b=1991-2020&r=mediterranean|sahara|amazon|arctic&t=stats>

## 5. Methodik (Kurzfassung)

* Jahres-/Saisonmittel aus Monatswerten; ein Jahr zählt, wenn ≥ ⅔ der Monate Daten haben.
  Der laufende, noch unvollständige Zeitraum wird weggelassen; Winter (DJF) nutzt den
  Dezember des Vorjahres.
* Trend: kleinste Quadrate; Standardfehler und p-Wert mit effektiver Stichprobengröße
  n_eff = n·(1−r₁)/(1+r₁) (Santer et al. 2000). Zellen brauchen ≥ ⅔ der Jahre und Daten in
  jedem Drittel des Zeitraums.
* Robust: Theil-Sen-Steigung, Mann-Kendall-Test (scipy).
* Regionen: Mittel mit Gewicht cos(Breite) × Anteil der Zelle in der Region (auch über die
  Datumsgrenze); Jahre mit < ⅓ Flächenabdeckung entfallen.
* Zeitpunkt des Hervortretens: erstes Jahr, ab dem das 11-Jahres-Mittel dauerhaft > 2σ der
  (trendbereinigten) Schwankung der Referenzperiode liegt (Hawkins & Sutton 2012).
* Extreme: jede Zelle-Jahr standardisiert mit eigenem Mittel/σ der Referenzperiode;
  flächengewichtete Histogramme je Zeitraum.

Validierung (1979–2025, Jahresmittel): globaler Trend **+0,21 ± 0,04 °C/Dekade** (Literatur
≈ 0,2), Arktis **+0,71 °C/Dekade = 3,4× global** (arktische Verstärkung, Literatur 3–4× seit
1979), Mittelmeer 2,1×, NRW 2,4×, Antarktis 0,7×, Südpazifik 0,5×; globale Jahresanomalie 2025
≈ +1,2 °C ggü. 1951–1980 – konsistent mit den NASA-Veröffentlichungen. Niederschlag: globaler
Trend ≈ 0, Arktis signifikant feuchter (+4 %/Dekade).

## 6. Dateien

| Datei | Inhalt |
|---|---|
| `global_data.py` | Download/Laden von GISTEMP (netCDF3) und GPCP (netCDF3 über den THREDDS-Subset-Dienst, in Zehnjahresstücken) – nur scipy, kein neues Paket |
| `global_analysis.py` | Regionen, Saisonmittel, Trends, Kartenebenen, Statistik, Ranking, Hovmöller, Extreme |
| `global_api.py` | `GET /api/global/{meta,layer,frames,regions,cell,ranking,zonal,distribution}`, Datensatz über `?ds=gistemp|gpcp`; `frames?res=monthly&from&to` liefert Monatskarten (≤ 20 Jahre, gzip) |
| `explorer/` | Oberfläche (MapLibre-Globus, Canvas-Overlay, Zeitleiste `timebar.js`, SVG-Diagramme ohne weitere Bibliotheken) |
| `static/vendor/` | MapLibre GL 6.18 (aus `map-widget/node_modules`), Natural-Earth-Küstenlinie |
| `tests/test_global_analysis.py` | 27 Tests auf synthetischen Gittern mit bekannten Trends (Temperatur & Niederschlag) |

`app.py` hat nur zwei Ergänzungen (Weiterleitung der `/api/global/`-Anfragen, Redirect
`/explorer` → `/explorer/`).

## 7. Grenzen & nächste Schritte

* **Auflösung 2°** (~220 km): NRW besteht aus 6 Teilzellen. Für Städte/kleine Regionen ist die
  Stationsanalyse besser – beides ergänzt sich (Idee: Klick im Explorer → „Stationen hier
  auswerten“).
* **Weitere Variablen** lassen sich über `DATASETS` in `global_data.py` ergänzen, z. B.
  NSIDC-Meereis, ERA5-Monatsmittel (Copernicus, kostenloser Schlüssel) oder Berkeley Earth
  (1°, ~450 MB). Der THREDDS-Trick (netCDF3 per Subset-Dienst) funktioniert für viele
  NOAA-PSL-Datensätze; direkte netCDF4/HDF5-Dateien bräuchten `h5py`.
* **Frühe Jahre** haben in Polarregionen, Afrika und Südmeeren wenige Messungen – die
  Flächenabdeckung wird angezeigt, die Statistik ignoriert Jahre mit zu geringer Abdeckung.
* GISTEMP glättet über bis zu 1200 km → kleinere Schwankungen (σ) als an Einzelstationen;
  relevant für die Extreme-Ansicht (Hinweis in der App).
* Mögliche Erweiterungen: Land/Meer-Maske, Vergleich zweier Zeiträume als Differenzkarte,
  Export der Karte als PNG, Kombination mit den Stationsdaten des bisherigen Tools.
