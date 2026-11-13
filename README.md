# Earth Case Files

Be an Earth system trend detective. Click anywhere on Earth and investigate 35 years of real NASA climate data for that place, then get a verdict and recommended actions.

Built for the NASA Space Apps Challenge, challenge **"Be An Earth System Trend Detective!"**

## Project summary

Earth Case Files turns climate data into detective work. The user clicks anywhere on a dark world map (or picks a cold-case preset such as Chattogram, the Amazon, or Phoenix) and the app opens a case file for that exact point. For each of four variables — temperature, rainfall, sunlight, and humidity — the app fetches 1990 to the latest full year from NASA POWER, draws the observed line with a dashed least-squares trend line, shows three evidence cards (trend per decade, anomaly, latest full-year value), and writes a plain-language story with a verdict and a "What to do" list. A compare mode overlays two places (Place A in amber, Place B in blue) with separate cards and stories. A satellite layer selector overlays NASA GIBS MODIS Terra true-color or NDVI imagery on a dark basemap with a 4-year date slider. The header shows a round whole-Earth photo from NASA EPIC on DSCOVR. Everything runs in the browser with no backend and no build step.

## Data sources and exact endpoints used

All climate values are live NASA data. Nothing is hard-coded, invented, or randomized. If data is unavailable the app says so.

### 1. NASA POWER — climate time series (main data, no key)

```
GET https://power.larc.nasa.gov/api/temporal/monthly/point?parameters=T2M,PRECTOTCORR,ALLSKY_SFC_SW_DWN,RH2M&community=AG&longitude={lon}&latitude={lat}&start=1990&end={lastFullYear}&format=JSON
```

- `lastFullYear` is the current year minus one (for example, 2025 when run in 2026). The app uses whatever annual values the API returns.
- Response path: `properties.parameter.{PARAM}["YYYYMM"]`.
- Month key `13` (`YYYY13`) is the annual mean and is used for the yearly view and all trend math. Months `01`–`12` are used for the monthly view.
- `-999` (and any value below -900) is treated as missing (`null`).
- Units: `T2M` °C, `PRECTOTCORR` mm/day, `ALLSKY_SFC_SW_DWN` kWh/m²/day, `RH2M` %.
- Longitude is normalized to -180..180 and latitude clamped to -89..89 before calling. Responses are cached in memory by rounded lat/lon.
- Requests use an `AbortController` with a 20-second timeout. Failures show an error panel with what happened, how to fix it, and a Retry button.

### 2. NASA GIBS — satellite imagery (no key)

Leaflet `tileLayer` over a dark basemap. Date slider covers the last 4 years plus a date input.

True color (daily):

```
https://gibs.earthdata.nasa.gov/wmts/epsg3857/best/MODIS_Terra_CorrectedReflectance_TrueColor/default/{YYYY-MM-DD}/GoogleMapsCompatible_Level9/{z}/{y}/{x}.jpg
```

Vegetation NDVI (monthly):

```
https://gibs.earthdata.nasa.gov/wmts/epsg3857/best/MODIS_Terra_L3_NDVI_Monthly/default/{YYYY-MM-01}/GoogleMapsCompatible_Level7/{z}/{y}/{x}.png
```

- True color uses `maxNativeZoom 9`. NDVI uses `maxNativeZoom 7`.
- **Fix documented:** the brief specified `GoogleMapsCompatible_Level9` for NDVI, but GIBS only publishes NDVI in `GoogleMapsCompatible_Level7`. Level 9 returns `400 TILEMATRIXSET is invalid for LAYER`. The app uses Level 7 for NDVI, which returns 200 tiles with no 404 flood.
- For NDVI the date is clamped to at least 75 days ago and snapped to the first of the month, because recent months are not published yet. The UI shows the effective month and explains the lag.

Basemap note: the brief specified a dark CARTO basemap (`dark_all`). As of November 2026 CARTO tiles without an API key return watermark-only tiles reading "API KEY REQUIRED" (verified with live tile requests). To keep the site production-ready without a key, the app uses Esri World Dark Gray Base as the dark basemap:

```
https://server.arcgisonline.com/ArcGIS/rest/services/Canvas/World_Dark_Gray_Base/MapServer/tile/{z}/{y}/{x}
```

The dark-basemap design intent and satellite overlay are preserved. Attribution is shown in the Leaflet control.

### 3. NASA EPIC — whole-Earth photo (API key from env file)

```
GET https://api.nasa.gov/EPIC/api/natural?api_key={KEY}
```

Image URL built from the item's `date` and `image` fields:

```
https://epic.gsfc.nasa.gov/archive/natural/{YYYY}/{MM}/{DD}/jpg/{image}.jpg
```

Shown as a small round photo with a caption in the header. Hidden cleanly (no broken image) if the call fails. The key lives in `.env` (`NASA_API_KEY=...`) and is loaded by the browser via `env.js` (`window.EARTH_CASE_FILES_NASA_KEY`), which `index.html` loads before `app.js`. To change the key, update both `.env` and `env.js` and reload. If `env.js` is missing the app falls back to `DEMO_KEY`. Get a key at https://api.nasa.gov. Note: this is a static site with no backend, so the key in `env.js` is visible in the page source — NASA keys are free, but rotate if abused. For a public deploy, add `.env` to `.gitignore` and generate `env.js` at deploy time.

Libraries (CDN, cdnjs): Leaflet 1.9.4, Chart.js 4.4.1. Fonts: Fraunces (headings, big numbers) and IBM Plex Sans (body) via Google Fonts.

Note on Chart.js URL: the correct cdnjs path uses capital letters — `https://cdnjs.cloudflare.com/ajax/libs/Chart.js/4.4.1/chart.umd.min.js`. The lowercase `chart.js` path returns 404.

## How to run locally

No build step. Serve the folder statically:

```bash
cd earth-case-files
python3 -m http.server 8000
# Open http://localhost:8000/index.html
```

Or open `index.html` directly in a browser (note: `fetch` to NASA APIs works from `file://` in most browsers, but a local server is recommended).

## How to deploy free

### Netlify Drop (fastest)

1. Zip the `earth-case-files` folder (or drag the folder itself).
2. Go to https://app.netlify.com/drop and drag the folder onto the page.
3. Netlify gives you a live URL in seconds. No build command needed.

### GitHub Pages

1. Create a GitHub repository and push the folder contents (`index.html`, `style.css`, `app.js`, `assets/`, `screenshots/`, `README.md`).
2. In the repo, go to Settings → Pages → Build and deployment → Source: Deploy from a branch.
3. Select the branch and `/ (root)` folder, then Save. The site goes live at `https://<username>.github.io/<repo>/`.

## How the trend and anomaly are calculated

All math is done in the browser from the raw POWER annual means. No server-side processing.

**Trend per decade (least-squares fit on yearly means):** For each variable, collect all non-missing annual values (`YYYY13`) from 1990 to the latest full year. Fit `y = slope * x + intercept` by ordinary least squares where `x` is the calendar year and `y` is the annual mean. The trend per decade is `slope * 10`. The dashed line on the chart is `intercept + slope * x` evaluated at each plotted year (yearly view) or at each month's decimal year `year + (month-1)/12` (monthly view), so the trend line stays correct when toggling views. The footer states this method.

**Anomaly:** Mean of the last 10 available years minus mean of 1990–2000 (inclusive). For rainfall the card also shows the percentage change `(anomaly / baseline mean) * 100`, which drives the story thresholds (drying below -8%, wetting above +8%).

**Latest full-year value:** The most recent year with a non-missing annual value.

**Temperature trend colours:** Red if rising above +0.1 °C/decade, blue if falling below -0.1 °C/decade, green if flat (between -0.1 and +0.1). Other variables use neutral styling.

**Story generator:** Each tab writes its own hook (verdict), three evidence sentences (trend, anomaly, latest — all with real numbers and years), and a "What to do" list. Examples: warming above 0.3 °C/decade triggers heat planning; rainfall down more than 8% triggers water-storage protection; rainfall up more than 8% triggers drainage and flood-map review. Sunlight and humidity have analogous thresholds.

**Validation:** The Chattogram temperature trend was checked independently in Python from the raw POWER response: least-squares slope gives -0.0978 °C/decade, which rounds to the -0.10 °C/decade shown on screen. Anomaly -0.204 °C rounds to -0.20 °C, latest 25.75 °C matches. Rainfall trend +3.023 mm/day/decade matches the screen.

## Limitations

- NASA POWER is a gridded product (about 0.5° resolution), not a weather station. A click represents the grid cell containing that point, which can mix land, coast, and ocean. Ocean points return data (POWER covers oceans) but should be interpreted as marine grid cells.
- POWER combines multiple sources (SRB, SYN1DEG, MERRA2) over 1990–present. Source changes can introduce jumps, especially for precipitation in very wet places (for example, Chattogram rainfall rises sharply in the 2010s in POWER). Trends are fits to the published series as-is.
- The latest full year is current year minus one. POWER may lag further; the app uses the latest annual value actually returned and labels it.
- GIBS true-color imagery has gaps on some dates (especially in the 2000s). The 4-year slider focuses on recent dates where coverage is continuous. NDVI is monthly with a publication lag (clamped to 75+ days ago).
- EPIC with DEMO_KEY is rate-limited (30 requests/hour/IP). When limited, the header photo hides cleanly. Use a personal key in `.env` / `env.js` for higher limits.
- This is not an official NASA product. Trends are least-squares fits on yearly means and should not be used for engineering or safety decisions without expert review.

## Credits

- Climate data: NASA POWER (https://power.larc.nasa.gov/), NASA Langley Research Center.
- Satellite imagery: NASA GIBS, MODIS Terra (https://gibs.earthdata.nasa.gov/).
- Earth photo: NASA EPIC on DSCOVR (https://epic.gsfc.nasa.gov/), via https://api.nasa.gov/.
- Basemap: Esri World Dark Gray Base (see basemap note above). Map library: Leaflet. Charts: Chart.js. Fonts: Fraunces and IBM Plex Sans.
- Logo, favicon, and share image generated for this project. Narration voiced with a synthetic voice; background music synthesized for the demo video.

## Files

```
index.html          — page structure, header, map, panel, footer
style.css           — design system (ink #060e1b, panel #0d1a2e, amber #f2b134, blue #7aa7ff)
app.js              — map, POWER fetch, charts, trend math, stories, compare, GIBS, EPIC
.env                — NASA_API_KEY for EPIC (source of truth, keep in sync with env.js)
env.js              — browser-loaded key (window.EARTH_CASE_FILES_NASA_KEY), loaded before app.js
assets/logo.png     — magnifying glass over globe, amber ring
assets/favicon-32.png / assets/favicon-180.png
assets/og-image.png — 1200x630 share image
assets/audio/narration.mp3 (64.5s) + narration-script.txt
assets/audio/music.mp3 (68s calm cinematic bed)
screenshots/        — 5 desktop (1440x900) + 2 mobile (390x844)
README.md           — this file
SUBMISSION.md       — 250-word Space Apps submission description
```

## Acceptance test summary (Nov 2026)

All 12 acceptance tests were run with Playwright (Chromium) against the live site with real NASA data. No console errors. EPIC photo loads, or hides cleanly when DEMO_KEY is rate-limited. Map clicks and all 9 presets load all four tabs with correct units. Yearly/monthly toggle keeps the trend correct. Compare mode overlays two places and switching back removes Place B. True-color, NDVI, and None layers work; the date slider changes imagery; NDVI returns zero 4xx responses. Ocean clicks return data without crashing. Blocking POWER shows the error panel and Retry works. No horizontal overflow at 1440px, 1024px, and 390px. All controls are keyboard-reachable with visible focus. Contrast ratios all pass WCAG AA (lowest 6.37:1). Page loads in under 2 seconds on a normal connection. Trend math validated independently (see above).
