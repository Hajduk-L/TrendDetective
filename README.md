# TrendDetective
Be An Earth System Trend Detective!

## Run the website

```bash
python3 app.py
```

Open http://127.0.0.1:8000. Choose a timestamp, an interval and topics in the sidebar, draw an
area on the world map, and click **Apply**.

## Map widget

The world map is the widget in [`map-widget/`](map-widget/), built into [`static/map-widget/`](static/map-widget/).

- [map-widget/API.md](map-widget/API.md) – how the page uses the widget (what it needs, what it delivers)
- [map-widget/DEVELOPMENT.md](map-widget/DEVELOPMENT.md) – how the widget works internally

After changing widget code, rebuild the bundle and commit `static/map-widget/`:

```bash
cd map-widget && npm install && npm run build:embed
```
