/* Earth Case Files — NASA Space Apps Challenge: Be An Earth System Trend Detective!
 * Data: NASA POWER (monthly/annual point API), NASA GIBS (WMTS), NASA EPIC.
 * No backend. All climate values come from live NASA POWER responses.
 */
(function () {
  "use strict";

  var PARAMS = {
    T2M: {
      label: "Temperature",
      unit: "°C",
      shortUnit: "°C",
      decimals: 2,
      trendDecimals: 2,
      description: "2-metre air temperature"
    },
    PRECTOTCORR: {
      label: "Rainfall",
      unit: "mm/day",
      shortUnit: "mm/day",
      decimals: 2,
      trendDecimals: 3,
      description: "Precipitation corrected"
    },
    ALLSKY_SFC_SW_DWN: {
      label: "Sunlight",
      unit: "kWh/m²/day",
      shortUnit: "kWh/m²/day",
      decimals: 2,
      trendDecimals: 2,
      description: "All-sky surface solar radiation"
    },
    RH2M: {
      label: "Humidity",
      unit: "%",
      shortUnit: "%",
      decimals: 1,
      trendDecimals: 1,
      description: "Relative humidity at 2 metres"
    }
  };
  var PARAM_ORDER = ["T2M", "PRECTOTCORR", "ALLSKY_SFC_SW_DWN", "RH2M"];

  var PRESETS = [
    { label: "Chattogram", lat: 22.34, lon: 91.83 },
    { label: "Bangladesh coast", lat: 21.8, lon: 90.2 },
    { label: "Amazon", lat: -3.5, lon: -62 },
    { label: "Arctic Siberia", lat: 70, lon: 100 },
    { label: "Sahara", lat: 23, lon: 13 },
    { label: "Himalayas", lat: 28, lon: 86.9 },
    { label: "Greenland coast", lat: 68, lon: -50 },
    { label: "Australian outback", lat: -25, lon: 134 },
    { label: "Phoenix", lat: 33.45, lon: -112.07 }
  ];

  var MONTH_NAMES = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

  var state = {
    compare: false,
    view: "yearly",
    tab: "T2M",
    places: { A: null, B: null },
    cache: new Map(),
    chart: null,
    markers: { A: null, B: null },
    requestSeq: { A: 0, B: 0 },
    lastError: null,
    sat: { type: "none", date: null, layer: null, tileErrors: 0 },
    epicKey: "DEMO_KEY",
    caseCount: 0,
    userOpenedCase: false
  };

  var prefersReducedMotion = false;
  try {
    prefersReducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  } catch (e) {
    prefersReducedMotion = false;
  }

  /* ---------- Utilities ---------- */

  function $(id) { return document.getElementById(id); }

  function clampLat(lat) {
    var n = Number(lat);
    if (!isFinite(n)) return 0;
    return Math.max(-89, Math.min(89, n));
  }

  function normalizeLon(lon) {
    var n = Number(lon);
    if (!isFinite(n)) return 0;
    var x = ((n + 540) % 360) - 180;
    // Keep -180..180; map exactly 180 to 180, -180 stays -180.
    if (x === -180 && n > 0) return 180;
    return x;
  }

  function formatCoords(lat, lon) {
    var la = Math.abs(lat).toFixed(2) + "°" + (lat >= 0 ? "N" : "S");
    var lo = Math.abs(lon).toFixed(2) + "°" + (lon >= 0 ? "E" : "W");
    return la + ", " + lo;
  }

  function placeLabel(slot, place) {
    if (!place) return "Place " + slot;
    return "Place " + slot + " (" + formatCoords(place.lat, place.lon) + ")";
  }

  function getLastFullYear() {
    return new Date().getFullYear() - 1;
  }

  function isMissing(v) {
    if (v === null || v === undefined) return true;
    var n = Number(v);
    if (!isFinite(n)) return true;
    // POWER fill value is -999. No real climate value is below -900.
    if (n <= -999 || n < -900) return true;
    return false;
  }

  function mean(arr) {
    if (!arr.length) return null;
    var s = 0;
    for (var i = 0; i < arr.length; i++) s += arr[i];
    return s / arr.length;
  }

  function linearRegression(xs, ys) {
    var n = xs.length;
    if (n < 2) return { slope: 0, intercept: 0 };
    var mx = mean(xs), my = mean(ys);
    var num = 0, den = 0;
    for (var i = 0; i < n; i++) {
      num += (xs[i] - mx) * (ys[i] - my);
      den += (xs[i] - mx) * (xs[i] - mx);
    }
    var slope = den === 0 ? 0 : num / den;
    var intercept = my - slope * mx;
    return { slope: slope, intercept: intercept };
  }

  function formatValue(v, paramKey, isTrend) {
    if (v === null || v === undefined || !isFinite(v)) return "—";
    var cfg = PARAMS[paramKey];
    var dec = isTrend ? cfg.trendDecimals : cfg.decimals;
    var sign = "";
    if (isTrend && v > 0) sign = "+";
    // For anomaly, show sign too when caller wants; handled by caller.
    return sign + v.toFixed(dec) + " " + cfg.shortUnit;
  }

  function formatAnomaly(v, paramKey) {
    if (v === null || v === undefined || !isFinite(v)) return "—";
    var cfg = PARAMS[paramKey];
    var sign = v > 0 ? "+" : "";
    return sign + v.toFixed(cfg.decimals) + " " + cfg.shortUnit;
  }

  function formatTrend(v, paramKey) {
    if (v === null || v === undefined || !isFinite(v)) return "—";
    var cfg = PARAMS[paramKey];
    var sign = v > 0 ? "+" : "";
    return sign + v.toFixed(cfg.trendDecimals) + " " + cfg.shortUnit + " per decade";
  }

  function trendClass(paramKey, trendPerDecade) {
    if (paramKey !== "T2M") return "";
    if (trendPerDecade === null || !isFinite(trendPerDecade)) return "";
    if (trendPerDecade > 0.1) return "trend-warm";
    if (trendPerDecade < -0.1) return "trend-cool";
    return "trend-flat";
  }

  function pad2(n) { return (n < 10 ? "0" : "") + n; }

  function toISODate(d) {
    return d.getFullYear() + "-" + pad2(d.getMonth() + 1) + "-" + pad2(d.getDate());
  }

  function fromISODate(s) {
    var parts = String(s).split("-");
    if (parts.length !== 3) return null;
    var d = new Date(Number(parts[0]), Number(parts[1]) - 1, Number(parts[2]));
    return isNaN(d.getTime()) ? null : d;
  }

  function formatLongDate(d) {
    var months = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
    return d.getDate() + " " + months[d.getMonth()] + " " + d.getFullYear();
  }

  function debounce(fn, wait) {
    var t = null;
    return function () {
      var args = arguments, self = this;
      if (t) clearTimeout(t);
      t = setTimeout(function () { fn.apply(self, args); }, wait);
    };
  }

  /* ---------- POWER parsing & stats ---------- */

  function parsePower(json) {
    if (!json || !json.properties || !json.properties.parameter) {
      throw new Error("NASA POWER returned an unexpected response. The data could not be read.");
    }
    var raw = json.properties.parameter;
    var annual = {};
    var monthly = {};
    PARAM_ORDER.forEach(function (p) {
      annual[p] = [];
      monthly[p] = [];
      var series = raw[p] || {};
      Object.keys(series).forEach(function (key) {
        var year = parseInt(key.slice(0, 4), 10);
        var month = parseInt(key.slice(4, 6), 10);
        var val = series[key];
        var v = isMissing(val) ? null : Number(val);
        if (month === 13) {
          annual[p].push({ year: year, value: v });
        } else if (month >= 1 && month <= 12) {
          monthly[p].push({
            year: year,
            month: month,
            value: v,
            decimalYear: year + (month - 1) / 12,
            label: MONTH_NAMES[month - 1] + " " + year,
            key: year + "-" + pad2(month)
          });
        }
      });
      annual[p].sort(function (a, b) { return a.year - b.year; });
      monthly[p].sort(function (a, b) {
        if (a.year !== b.year) return a.year - b.year;
        return a.month - b.month;
      });
    });
    return { annual: annual, monthly: monthly, raw: json };
  }

  function computeStats(annualSeries) {
    var pts = annualSeries.filter(function (p) { return p.value !== null && isFinite(p.value); });
    if (pts.length < 2) return null;
    var xs = pts.map(function (p) { return p.year; });
    var ys = pts.map(function (p) { return p.value; });
    var reg = linearRegression(xs, ys);
    var trendPerDecade = reg.slope * 10;
    var baseline = pts.filter(function (p) { return p.year >= 1990 && p.year <= 2000; });
    var recent = pts.slice(-10);
    var baselineMean = baseline.length ? mean(baseline.map(function (p) { return p.value; })) : null;
    var recentMean = recent.length ? mean(recent.map(function (p) { return p.value; })) : null;
    var anomaly = (baselineMean !== null && recentMean !== null) ? (recentMean - baselineMean) : null;
    var pctChange = (anomaly !== null && baselineMean !== null && baselineMean !== 0)
      ? (anomaly / baselineMean) * 100 : null;
    var latest = pts[pts.length - 1];
    return {
      slope: reg.slope,
      intercept: reg.intercept,
      trendPerDecade: trendPerDecade,
      baselineMean: baselineMean,
      recentMean: recentMean,
      anomaly: anomaly,
      pctChange: pctChange,
      latest: latest,
      firstYear: pts[0].year,
      lastYear: latest.year,
      n: pts.length,
      baselineYears: baseline.length ? [baseline[0].year, baseline[baseline.length - 1].year] : null,
      recentYears: recent.length ? [recent[0].year, recent[recent.length - 1].year] : null
    };
  }

  function statsForPlace(place, paramKey) {
    if (!place || !place.data) return null;
    if (!place.stats[paramKey]) {
      place.stats[paramKey] = computeStats(place.data.annual[paramKey]);
    }
    return place.stats[paramKey];
  }

  /* ---------- Story generator ---------- */

  function buildStory(slot, place, paramKey, stats) {
    var cfg = PARAMS[paramKey];
    var label = placeLabel(slot, place);
    if (!stats) {
      return {
        hook: "Not enough data to write a verdict for " + label + ".",
        evidence: ["NASA POWER returned too few yearly values for " + cfg.label.toLowerCase() + " at this place to fit a trend."],
        actions: ["Try a nearby land location — ocean and remote grid cells can have gaps.", "Check the other tabs — some variables may have data even when this one does not."]
      };
    }
    var trend = stats.trendPerDecade;
    var anomaly = stats.anomaly;
    var latest = stats.latest;
    var evidence = [];

    // Evidence sentences (always from real numbers).
    if (paramKey === "T2M") {
      var dir = trend > 0 ? "risen" : (trend < 0 ? "fallen" : "stayed roughly flat");
      evidence.push(cfg.label + " has " + dir + " by " + Math.abs(trend).toFixed(2) + " °C per decade since " + stats.firstYear + " (least-squares fit on yearly means).");
      if (anomaly !== null) {
        var warmer = anomaly >= 0 ? "warmer" : "cooler";
        evidence.push("The last 10 years (" + stats.recentYears[0] + "–" + stats.recentYears[1] + ") averaged " + Math.abs(anomaly).toFixed(2) + " °C " + warmer + " than 1990–2000.");
      }
      evidence.push("The latest full year (" + latest.year + ") averaged " + latest.value.toFixed(2) + " °C.");
    } else if (paramKey === "PRECTOTCORR") {
      var rdir = trend > 0 ? "risen" : (trend < 0 ? "fallen" : "stayed roughly flat");
      evidence.push("Rainfall has " + rdir + " by " + Math.abs(trend).toFixed(3) + " mm/day per decade since " + stats.firstYear + " (least-squares fit on yearly means).");
      if (anomaly !== null) {
        var pct = stats.pctChange !== null ? " (" + (stats.pctChange >= 0 ? "up" : "down") + " " + Math.abs(stats.pctChange).toFixed(1) + "%)" : "";
        var rwarmer = anomaly >= 0 ? "wetter" : "drier";
        evidence.push("The last 10 years (" + stats.recentYears[0] + "–" + stats.recentYears[1] + ") averaged " + Math.abs(anomaly).toFixed(2) + " mm/day " + rwarmer + " than 1990–2000" + pct + ".");
      }
      evidence.push("The latest full year (" + latest.year + ") averaged " + latest.value.toFixed(2) + " mm/day.");
    } else if (paramKey === "ALLSKY_SFC_SW_DWN") {
      var sdir = trend > 0 ? "risen" : (trend < 0 ? "fallen" : "stayed roughly flat");
      evidence.push("Sunlight reaching the surface has " + sdir + " by " + Math.abs(trend).toFixed(2) + " kWh/m²/day per decade since " + stats.firstYear + " (least-squares fit on yearly means).");
      if (anomaly !== null) {
        var sunnier = anomaly >= 0 ? "sunnier" : "dimmer";
        evidence.push("The last 10 years (" + stats.recentYears[0] + "–" + stats.recentYears[1] + ") averaged " + Math.abs(anomaly).toFixed(2) + " kWh/m²/day " + sunnier + " than 1990–2000.");
      }
      evidence.push("The latest full year (" + latest.year + ") averaged " + latest.value.toFixed(2) + " kWh/m²/day.");
    } else if (paramKey === "RH2M") {
      var hdir = trend > 0 ? "risen" : (trend < 0 ? "fallen" : "stayed roughly flat");
      evidence.push("Humidity has " + hdir + " by " + Math.abs(trend).toFixed(1) + " percentage points per decade since " + stats.firstYear + " (least-squares fit on yearly means).");
      if (anomaly !== null) {
        var moreHumid = anomaly >= 0 ? "more humid" : "drier";
        evidence.push("The last 10 years (" + stats.recentYears[0] + "–" + stats.recentYears[1] + ") averaged " + Math.abs(anomaly).toFixed(1) + " percentage points " + moreHumid + " than 1990–2000.");
      }
      evidence.push("The latest full year (" + latest.year + ") averaged " + latest.value.toFixed(1) + "% humidity.");
    }

    var hook = "";
    var actions = [];

    if (paramKey === "T2M") {
      if (trend > 0.3) {
        hook = "Verdict: fast warming at " + label + ". The heat is climbing well beyond the noise.";
        actions = [
          "Plan for heat: shade trees, cool roofs and heat-action plans for outdoor work.",
          "Check water and energy demand on hot days — cooling needs rise with temperature.",
          "Review building ventilation and insulation before the next hot season."
        ];
      } else if (trend > 0.1) {
        hook = "Verdict: steady warming at " + label + ". The trend is clear and persistent.";
        actions = [
          "Prepare for hotter summers: adjust work and school schedules on extreme days.",
          "Keep water and power plans ready for heatwaves.",
          "Plant shade and check on neighbours during hot spells."
        ];
      } else if (trend < -0.1) {
        hook = "Verdict: cooling trend at " + label + ". The thermometer story runs against the global picture.";
        actions = [
          "Keep cold-weather resilience: heating, insulation and frost protection still matter.",
          "Check pipes and crops for cold snaps even as the average falls.",
          "Keep monitoring — a cooling fit does not rule out hot extremes."
        ];
      } else {
        hook = "Verdict: no clear warming trend at " + label + ". The average has held roughly steady.";
        actions = [
          "Keep monitoring — flat does not mean safe, extremes can still shift.",
          "Maintain current heat and cold plans for this place.",
          "Revisit this case file in a few years as new data arrives."
        ];
      }
    } else if (paramKey === "PRECTOTCORR") {
      var pct = stats.pctChange;
      if (pct !== null && pct < -8) {
        hook = "Verdict: drying trend at " + label + ". Less rain is arriving than in the 1990s.";
        actions = [
          "Protect water storage: rain harvesting, leak repair and efficient irrigation.",
          "Plan for dry spells: know where backup water comes from.",
          "Watch wells and tanks through the dry season."
        ];
      } else if (pct !== null && pct > 8) {
        hook = "Verdict: wetter trend at " + label + ". More rain is arriving than in the 1990s.";
        actions = [
          "Improve drainage: clear drains, check culverts and keep flood paths open.",
          "Review flood maps for homes, roads and farms near low ground.",
          "Store valuables above flood level where flooding is likely."
        ];
      } else {
        hook = "Verdict: rainfall broadly stable at " + label + ". No strong drying or wetting signal.";
        actions = [
          "Maintain current water and drainage systems.",
          "Keep flood and drought plans ready — averages hide extremes.",
          "Revisit this case file as new years are added."
        ];
      }
    } else if (paramKey === "ALLSKY_SFC_SW_DWN") {
      if (trend > 0.1) {
        hook = "Verdict: sunnier trend at " + label + ". More solar energy is reaching the surface.";
        actions = [
          "Solar opportunity: rooftop solar is worth costing for homes and schools.",
          "Plan shade for outdoor work on bright days.",
          "Check glare and heat gain in west-facing rooms."
        ];
      } else if (trend < -0.1) {
        hook = "Verdict: dimmer trend at " + label + ". Less solar energy is reaching the surface.";
        actions = [
          "Plan for cloudier conditions: solar output may be lower than expected.",
          "Keep backup power and lighting plans for dull spells.",
          "Check crops and gardens for lower light."
        ];
      } else {
        hook = "Verdict: sunlight broadly stable at " + label + ".";
        actions = [
          "Solar plans can use recent averages with confidence.",
          "Keep shade and glare protection for bright days.",
          "Revisit this case file as new years are added."
        ];
      }
    } else if (paramKey === "RH2M") {
      if (trend > 0.5) {
        hook = "Verdict: more humid trend at " + label + ". The air is holding more moisture.";
        actions = [
          "Watch mould and damp: ventilate rooms and fix leaks early.",
          "Plan for muggy heat — humid air makes hot days feel hotter.",
          "Check food storage and building materials in damp seasons."
        ];
      } else if (trend < -0.5) {
        hook = "Verdict: drier-air trend at " + label + ". Humidity is falling.";
        actions = [
          "Plan for dryness: dust, fire risk and dry soils need attention.",
          "Protect water storage and check irrigation needs.",
          "Watch for respiratory irritation in dry spells."
        ];
      } else {
        hook = "Verdict: humidity broadly stable at " + label + ".";
        actions = [
          "Maintain current ventilation and damp checks.",
          "Keep monitoring — humidity shapes comfort and health.",
          "Revisit this case file as new years are added."
        ];
      }
    }

    return { hook: hook, evidence: evidence, actions: actions };
  }

  /* ---------- Map ---------- */

  var map = null;

  function initMap() {
    var mapEl = $("map");
    if (typeof L === "undefined") {
      mapEl.innerHTML = "<p style='padding:1rem'>The map library could not be loaded. Check your connection and reload the page.</p>";
      return;
    }
    map = L.map("map", {
      worldCopyJump: true,
      zoomControl: true,
      attributionControl: true
    }).setView([24, 20], 2);

    // Dark basemap: Esri World Dark Gray Base (free, no key).
    // NOTE: CARTO dark_all tiles now return "API KEY REQUIRED" watermark tiles
    // without a CARTO API key (verified 2026-11-13), so the app uses Esri's
    // free dark basemap to keep the dark-basemap design working without a key.
    // The satellite overlay (GIBS) and all other features are unchanged.
    L.tileLayer("https://server.arcgisonline.com/ArcGIS/rest/services/Canvas/World_Dark_Gray_Base/MapServer/tile/{z}/{y}/{x}", {
      attribution: 'Basemap &copy; <a href="https://www.esri.com/">Esri</a>, Maxar, Earthstar Geographics, and the GIS User Community',
      maxZoom: 19
    }).addTo(map);

    map.on("click", function (e) {
      openAt(e.latlng.lat, e.latlng.lng);
    });

    // Keyboard: Enter opens a case at the map centre.
    if (!mapEl.hasAttribute("tabindex")) mapEl.setAttribute("tabindex", "0");
    mapEl.addEventListener("keydown", function (e) {
      if (e.key === "Enter" && map) {
        var c = map.getCenter();
        openAt(c.lat, c.lng);
      }
    });

    window.addEventListener("resize", function () {
      if (map) map.invalidateSize();
    });
  }

  function markerIcon(slot) {
    var cls = slot === "B" ? "case-marker-b" : "case-marker-a";
    return L.divIcon({
      className: "",
      html: '<span class="case-marker ' + cls + '" aria-hidden="true"></span>',
      iconSize: [22, 22],
      iconAnchor: [11, 11]
    });
  }

  function updateMarker(slot, lat, lon) {
    if (!map) return;
    var ll = L.latLng(lat, lon);
    if (state.markers[slot]) {
      state.markers[slot].setLatLng(ll);
      state.markers[slot].setIcon(markerIcon(slot));
    } else {
      state.markers[slot] = L.marker(ll, { icon: markerIcon(slot), keyboard: false }).addTo(map);
    }
    state.markers[slot].bindTooltip(placeLabel(slot, { lat: lat, lon: lon }), { direction: "top", offset: [0, -12] });
  }

  function removeMarker(slot) {
    if (map && state.markers[slot]) {
      map.removeLayer(state.markers[slot]);
      state.markers[slot] = null;
    }
  }

  function flyToPlace(lat, lon) {
    if (!map) return;
    if (prefersReducedMotion) {
      map.setView([lat, lon], Math.max(map.getZoom(), 4));
    } else {
      map.flyTo([lat, lon], Math.max(map.getZoom(), 4), { duration: 1.2 });
    }
  }

  /* ---------- POWER fetch ---------- */

  function fetchPower(lat, lon) {
    var nlat = clampLat(lat);
    var nlon = normalizeLon(lon);
    var key = nlat.toFixed(3) + "," + nlon.toFixed(3);
    if (state.cache.has(key)) {
      return Promise.resolve(state.cache.get(key));
    }
    var end = getLastFullYear();
    var url = "https://power.larc.nasa.gov/api/temporal/monthly/point?parameters=T2M,PRECTOTCORR,ALLSKY_SFC_SW_DWN,RH2M&community=AG&longitude=" +
      encodeURIComponent(nlon) + "&latitude=" + encodeURIComponent(nlat) +
      "&start=1990&end=" + end + "&format=JSON";

    var controller = null;
    var timeoutId = null;
    if (typeof AbortController !== "undefined") {
      controller = new AbortController();
      timeoutId = setTimeout(function () { controller.abort(); }, 20000);
    }

    return fetch(url, controller ? { signal: controller.signal } : undefined)
      .then(function (res) {
        if (timeoutId) clearTimeout(timeoutId);
        if (!res.ok) {
          throw new Error("NASA POWER returned " + res.status + " " + res.statusText + ". The data service did not return a case file.");
        }
        return res.json();
      })
      .catch(function (err) {
        if (timeoutId) clearTimeout(timeoutId);
        if (err && err.name === "AbortError") {
          throw new Error("The request timed out after 20 seconds. NASA POWER did not answer in time.");
        }
        if (err instanceof SyntaxError) {
          throw new Error("NASA POWER returned data that could not be read. The response was not valid JSON.");
        }
        throw err;
      })
      .then(function (json) {
        var parsed = parsePower(json);
        state.cache.set(key, parsed);
        return parsed;
      });
  }

  /* ---------- Panel rendering ---------- */

  function showStatus(kind) {
    var empty = $("emptyState"), loading = $("loadingState"), error = $("errorState"), content = $("caseContent");
    if (kind === "empty") {
      empty.hidden = false; loading.hidden = true; error.hidden = true;
      content.hidden = true;
    } else if (kind === "loading") {
      empty.hidden = true; loading.hidden = false; error.hidden = true;
      // Keep existing case content visible if we already have data (compare B loading).
      var hasData = !!(state.places.A && state.places.A.data);
      content.hidden = !hasData;
    } else if (kind === "error") {
      empty.hidden = true; loading.hidden = true; error.hidden = false;
      var hasData2 = !!(state.places.A && state.places.A.data);
      content.hidden = !hasData2;
    } else if (kind === "data") {
      empty.hidden = true; loading.hidden = true; error.hidden = true;
      content.hidden = false;
    }
  }

  function updatePanelHead() {
    var a = state.places.A, b = state.places.B;
    var title = $("panelTitle"), coords = $("panelCoords");
    var caseLabel = state.caseCount > 0 ? "Case file #" + state.caseCount : "Case file";
    if (!a && !b) {
      title.textContent = "Case file";
      coords.textContent = "No place selected yet";
    } else if (a && !b) {
      title.textContent = caseLabel + " — Place A";
      var lastY = a.data ? latestYearFor(a) : getLastFullYear();
      coords.textContent = formatCoords(a.lat, a.lon) + " · NASA POWER 1990–" + lastY + " (" + (lastY - 1990 + 1) + " years)";
    } else if (a && b) {
      title.textContent = caseLabel + " — two places";
      coords.textContent = "A: " + formatCoords(a.lat, a.lon) + " · B: " + formatCoords(b.lat, b.lon);
    } else if (b && !a) {
      title.textContent = caseLabel + " — Place B";
      coords.textContent = formatCoords(b.lat, b.lon);
    }
    $("mapLegend").hidden = !(a || b);
    $("legendB").hidden = !b;
    $("compareHint").hidden = !(state.compare && a && !b);
    $("evidenceB").hidden = !b;
    $("storyB").hidden = !b;
  }

  function latestYearFor(place) {
    // Use the latest year available across T2M annual data.
    var s = place.data && place.data.annual && place.data.annual.T2M;
    if (!s || !s.length) return getLastFullYear();
    var valid = s.filter(function (p) { return p.value !== null; });
    return valid.length ? valid[valid.length - 1].year : getLastFullYear();
  }

  function renderCards(slot, place, paramKey) {
    var stats = statsForPlace(place, paramKey);
    var suffix = slot; // A or B
    var trendEl = $("trend" + suffix), trendSub = $("trendSub" + suffix);
    var anomalyEl = $("anomaly" + suffix), anomalySub = $("anomalySub" + suffix);
    var latestEl = $("latest" + suffix), latestSub = $("latestSub" + suffix);
    var cardsTitle = $("cardsTitle" + suffix);

    cardsTitle.textContent = "Evidence — " + placeLabel(slot, place) + " · " + PARAMS[paramKey].label;

    if (!stats) {
      trendEl.textContent = "—";
      trendEl.className = "card-value";
      trendSub.textContent = "Not enough yearly data";
      anomalyEl.textContent = "—";
      anomalySub.textContent = "Last 10 years minus 1990–2000";
      latestEl.textContent = "—";
      latestSub.textContent = "No data for this variable";
      return;
    }

    trendEl.textContent = formatTrend(stats.trendPerDecade, paramKey);
    trendEl.className = "card-value " + trendClass(paramKey, stats.trendPerDecade);
    trendSub.textContent = "Least-squares fit on yearly means, " + stats.firstYear + "–" + stats.lastYear;

    anomalyEl.textContent = formatAnomaly(stats.anomaly, paramKey);
    if (paramKey === "PRECTOTCORR" && stats.pctChange !== null) {
      anomalySub.textContent = "Last 10 years minus 1990–2000 (" + (stats.pctChange >= 0 ? "up" : "down") + " " + Math.abs(stats.pctChange).toFixed(1) + "%)";
    } else {
      anomalySub.textContent = "Last 10 years minus 1990–2000";
    }

    latestEl.textContent = stats.latest.value.toFixed(PARAMS[paramKey].decimals) + " " + PARAMS[paramKey].shortUnit;
    latestSub.textContent = stats.latest.year + " annual mean";
  }

  function renderStory(slot, place, paramKey) {
    var stats = statsForPlace(place, paramKey);
    var story = buildStory(slot, place, paramKey, stats);
    $("storyTitle" + slot).textContent = "Case file — " + placeLabel(slot, place) + " · " + PARAMS[paramKey].label;
    $("hook" + slot).textContent = story.hook;
    var ev = $("evidenceText" + slot);
    ev.innerHTML = "";
    story.evidence.forEach(function (s) {
      var p = document.createElement("p");
      p.textContent = s;
      ev.appendChild(p);
    });
    var ul = $("actions" + slot);
    ul.innerHTML = "";
    story.actions.forEach(function (a) {
      var li = document.createElement("li");
      li.textContent = a;
      ul.appendChild(li);
    });
  }

  function renderAll() {
    updatePanelHead();
    var a = state.places.A, b = state.places.B;
    if (a && a.data) {
      renderCards("A", a, state.tab);
      renderStory("A", a, state.tab);
    }
    if (b && b.data) {
      renderCards("B", b, state.tab);
      renderStory("B", b, state.tab);
    }
    renderChart();
  }

  /* ---------- Chart ---------- */

  function renderChart() {
    var canvas = $("chart");
    var fallback = $("chartFallback");
    var note = $("chartNote");
    var a = state.places.A, b = state.places.B;
    var paramKey = state.tab;
    var cfg = PARAMS[paramKey];

    if (!a || !a.data) {
      note.textContent = "";
      return;
    }

    // Update accessible description.
    canvas.setAttribute("aria-label",
      cfg.label + " chart (" + state.view + " view) for " + placeLabel("A", a) +
      (b && b.data ? " and " + placeLabel("B", b) : "") +
      ". Observed values with a dashed trend line. Use the evidence cards below for the numbers in text.");

    var tabPanel = $("tabPanel");
    tabPanel.setAttribute("aria-labelledby", "tab-" + paramKey);

    if (typeof Chart === "undefined") {
      fallback.hidden = false;
      fallback.textContent = "The chart library could not be loaded. The evidence cards and story below show the same numbers in text.";
      note.textContent = "";
      return;
    }
    fallback.hidden = true;

    var labels, datasets = [];

    if (state.view === "yearly") {
      var yearsMap = {};
      [a, b].forEach(function (pl) {
        if (!pl || !pl.data) return;
        pl.data.annual[paramKey].forEach(function (p) {
          yearsMap[p.year] = true;
        });
      });
      var years = Object.keys(yearsMap).map(Number).sort(function (x, y) { return x - y; });
      labels = years.map(function (y) { return String(y); });

      function yearlySeries(place) {
        var stats = statsForPlace(place, paramKey);
        var byYear = {};
        place.data.annual[paramKey].forEach(function (p) { byYear[p.year] = p.value; });
        var observed = years.map(function (y) {
          var v = byYear[y];
          return (v === undefined ? null : v);
        });
        var trend = years.map(function (y) {
          if (!stats) return null;
          return stats.intercept + stats.slope * y;
        });
        return { observed: observed, trend: trend };
      }

      var sa = yearlySeries(a);
      datasets.push({
        label: "Place A — observed",
        data: sa.observed,
        borderColor: "#f2b134",
        backgroundColor: "#f2b134",
        borderWidth: 2,
        pointRadius: 2,
        pointHoverRadius: 4,
        tension: 0,
        spanGaps: true
      });
      datasets.push({
        label: "Place A — trend",
        data: sa.trend,
        borderColor: "rgba(242,177,52,0.75)",
        borderDash: [6, 4],
        borderWidth: 1.5,
        pointRadius: 0,
        tension: 0,
        spanGaps: true
      });
      if (b && b.data) {
        var sb = yearlySeries(b);
        datasets.push({
          label: "Place B — observed",
          data: sb.observed,
          borderColor: "#7aa7ff",
          backgroundColor: "#7aa7ff",
          borderWidth: 2,
          pointRadius: 2,
          pointHoverRadius: 4,
          tension: 0,
          spanGaps: true
        });
        datasets.push({
          label: "Place B — trend",
          data: sb.trend,
          borderColor: "rgba(122,167,255,0.75)",
          borderDash: [6, 4],
          borderWidth: 1.5,
          pointRadius: 0,
          tension: 0,
          spanGaps: true
        });
      }
      note.textContent = "NASA POWER yearly means, " + years[0] + "–" + years[years.length - 1] + " (" + years.length + " years). Dashed line is the least-squares trend on yearly means.";
    } else {
      // Monthly view: use Place A month keys as the label base; align B by key.
      var monthsA = a.data.monthly[paramKey];
      labels = monthsA.map(function (m) { return m.label; });
      function monthlySeries(place) {
        var stats = statsForPlace(place, paramKey);
        var byKey = {};
        place.data.monthly[paramKey].forEach(function (m) { byKey[m.key] = m; });
        var observed = monthsA.map(function (m) {
          var rec = byKey[m.key];
          return rec ? rec.value : null;
        });
        var trend = monthsA.map(function (m) {
          if (!stats) return null;
          return stats.intercept + stats.slope * m.decimalYear;
        });
        return { observed: observed, trend: trend };
      }
      var ma = monthlySeries(a);
      datasets.push({
        label: "Place A — observed",
        data: ma.observed,
        borderColor: "#f2b134",
        backgroundColor: "#f2b134",
        borderWidth: 1.5,
        pointRadius: 0,
        pointHoverRadius: 3,
        tension: 0,
        spanGaps: true
      });
      datasets.push({
        label: "Place A — trend",
        data: ma.trend,
        borderColor: "rgba(242,177,52,0.75)",
        borderDash: [6, 4],
        borderWidth: 1.5,
        pointRadius: 0,
        tension: 0,
        spanGaps: true
      });
      if (b && b.data) {
        var mb = monthlySeries(b);
        datasets.push({
          label: "Place B — observed",
          data: mb.observed,
          borderColor: "#7aa7ff",
          backgroundColor: "#7aa7ff",
          borderWidth: 1.5,
          pointRadius: 0,
          pointHoverRadius: 3,
          tension: 0,
          spanGaps: true
        });
        datasets.push({
          label: "Place B — trend",
          data: mb.trend,
          borderColor: "rgba(122,167,255,0.75)",
          borderDash: [6, 4],
          borderWidth: 1.5,
          pointRadius: 0,
          tension: 0,
          spanGaps: true
        });
      }
      note.textContent = "NASA POWER monthly values, " + monthsA[0].label + " to " + monthsA[monthsA.length - 1].label + " (" + monthsA.length + " months). Dashed line uses the yearly trend extended across months.";
    }

    var config = {
      type: "line",
      data: { labels: labels, datasets: datasets },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        interaction: { mode: "index", intersect: false },
        plugins: {
          legend: {
            position: "top",
            labels: { color: "#e8eef8", usePointStyle: true, boxWidth: 8, font: { family: "'IBM Plex Sans', sans-serif", size: 12 } }
          },
          tooltip: {
            backgroundColor: "#12233b",
            titleColor: "#e8eef8",
            bodyColor: "#e8eef8",
            borderColor: "#233a5a",
            borderWidth: 1,
            callbacks: {
              label: function (ctx) {
                var v = ctx.parsed.y;
                if (v === null || v === undefined || !isFinite(v)) return ctx.dataset.label + ": No data";
                return ctx.dataset.label + ": " + v.toFixed(cfg.decimals) + " " + cfg.unit;
              }
            }
          }
        },
        scales: {
          x: {
            grid: { display: false, color: "#233a5a" },
            ticks: { color: "#93a6c2", maxTicksLimit: state.view === "yearly" ? 8 : 10, autoSkip: true, font: { family: "'IBM Plex Sans', sans-serif", size: 11 } },
            title: { display: true, text: state.view === "yearly" ? "Year" : "Month", color: "#93a6c2" }
          },
          y: {
            grid: { color: "#233a5a" },
            ticks: { color: "#93a6c2", font: { family: "'IBM Plex Sans', sans-serif", size: 11 } },
            title: { display: true, text: cfg.label + " (" + cfg.unit + ")", color: "#93a6c2" }
          }
        }
      }
    };

    if (state.chart) {
      state.chart.destroy();
      state.chart = null;
    }
    try {
      state.chart = new Chart(canvas.getContext("2d"), config);
    } catch (e) {
      fallback.hidden = false;
      fallback.textContent = "The chart could not be drawn. The evidence cards and story below show the same numbers in text.";
    }
  }

  /* ---------- Open case ---------- */

  function openAt(lat, lon) {
    state.userOpenedCase = true;
    state.caseCount++;
    var nlat = clampLat(lat);
    var nlon = normalizeLon(lon);
    var slot;
    if (!state.compare) {
      slot = "A";
      if (state.places.B) {
        state.places.B = null;
        removeMarker("B");
      }
    } else {
      if (!state.places.A) slot = "A";
      else if (!state.places.B) slot = "B";
      else {
        // Both set: start a new Place A and clear B.
        state.places.B = null;
        removeMarker("B");
        slot = "A";
      }
    }
    openPlace(slot, nlat, nlon);
  }

  function openPlace(slot, lat, lon) {
    var seq = ++state.requestSeq[slot];
    state.places[slot] = { lat: lat, lon: lon, data: null, stats: {}, loading: true };
    updateMarker(slot, lat, lon);
    updatePanelHead();
    showStatus("loading");
    $("loadingText").textContent = "Opening Place " + slot + " at " + formatCoords(lat, lon) + "…";
    state.lastError = null;

    fetchPower(lat, lon).then(function (data) {
      if (seq !== state.requestSeq[slot]) return; // stale
      var place = state.places[slot];
      if (!place) return;
      place.data = data;
      place.stats = {};
      place.loading = false;
      showStatus("data");
      renderAll();
      // On small screens, bring the case file into view after the user taps.
      if (state.userOpenedCase && window.innerWidth <= 860) {
        var panel = $("panel");
        if (panel) {
          if (prefersReducedMotion) panel.scrollIntoView({ block: "start" });
          else panel.scrollIntoView({ behavior: "smooth", block: "start" });
        }
      }
    }).catch(function (err) {
      if (seq !== state.requestSeq[slot]) return;
      var place = state.places[slot];
      if (place) place.loading = false;
      state.lastError = { slot: slot, lat: lat, lon: lon, message: err && err.message ? err.message : "Unknown error." };
      $("errorMessage").textContent = state.lastError.message + " Place " + slot + " (" + formatCoords(lat, lon) + ") could not be loaded.";
      showStatus("error");
      updatePanelHead();
    });
  }

  /* ---------- Tabs ---------- */

  function initTabs() {
    var tabs = Array.prototype.slice.call(document.querySelectorAll('[role="tab"]'));
    tabs.forEach(function (tab, idx) {
      tab.addEventListener("click", function () { selectTab(tab.dataset.param, true); });
      tab.addEventListener("keydown", function (e) {
        var next = null;
        if (e.key === "ArrowRight") next = tabs[(idx + 1) % tabs.length];
        else if (e.key === "ArrowLeft") next = tabs[(idx - 1 + tabs.length) % tabs.length];
        else if (e.key === "Home") next = tabs[0];
        else if (e.key === "End") next = tabs[tabs.length - 1];
        if (next) {
          e.preventDefault();
          selectTab(next.dataset.param, true);
          next.focus();
        }
      });
    });
  }

  function selectTab(paramKey, focus) {
    state.tab = paramKey;
    var tabs = document.querySelectorAll('[role="tab"]');
    tabs.forEach(function (t) {
      var selected = t.dataset.param === paramKey;
      t.setAttribute("aria-selected", selected ? "true" : "false");
      t.tabIndex = selected ? 0 : -1;
      if (selected && focus) t.focus();
    });
    $("tabPanel").setAttribute("aria-labelledby", "tab-" + paramKey);
    if (state.places.A && state.places.A.data) renderAll();
  }

  /* ---------- Toggles ---------- */

  function initToggles() {
    var compareToggle = $("compareToggle");
    compareToggle.addEventListener("change", function () {
      state.compare = compareToggle.checked;
      if (!state.compare) {
        // Switching back to one place removes Place B.
        state.places.B = null;
        removeMarker("B");
        state.requestSeq.B++;
      }
      updatePanelHead();
      if (state.places.A && state.places.A.data) renderAll();
      else if (!state.places.A && !state.places.B) showStatus("empty");
    });

    var radios = document.querySelectorAll('input[name="view"]');
    radios.forEach(function (r) {
      r.addEventListener("change", function () {
        if (r.checked) {
          state.view = r.value;
          if (state.places.A && state.places.A.data) renderAll();
        }
      });
    });

    $("retryButton").addEventListener("click", function () {
      if (state.lastError) {
        openPlace(state.lastError.slot, state.lastError.lat, state.lastError.lon);
      }
    });
  }

  /* ---------- Presets ---------- */

  function initPresets() {
    var wrap = $("presetChips");
    PRESETS.forEach(function (p) {
      var btn = document.createElement("button");
      btn.type = "button";
      btn.textContent = p.label;
      btn.setAttribute("aria-label", "Open case file for " + p.label + " at " + formatCoords(p.lat, p.lon));
      btn.addEventListener("click", function () {
        flyToPlace(p.lat, p.lon);
        openAt(p.lat, p.lon);
      });
      wrap.appendChild(btn);
    });
  }

  /* ---------- Satellite layers (GIBS) ---------- */

  function satDateBounds() {
    var today = new Date();
    today.setHours(0, 0, 0, 0);
    var min = new Date(today.getFullYear() - 4, today.getMonth(), today.getDate());
    return { min: min, max: today };
  }

  function ndviMaxDate() {
    var today = new Date();
    today.setHours(0, 0, 0, 0);
    var d = new Date(today.getTime() - 75 * 24 * 60 * 60 * 1000);
    // Snap to first of month.
    d = new Date(d.getFullYear(), d.getMonth(), 1);
    return d;
  }

  function effectiveSatDate() {
    var d = new Date(state.sat.date.getTime());
    if (state.sat.type === "ndvi") {
      var max = ndviMaxDate();
      if (d > max) d = new Date(max.getTime());
      d = new Date(d.getFullYear(), d.getMonth(), 1);
    }
    return d;
  }

  function initSatControls() {
    var select = $("satSelect");
    var range = $("satDateRange");
    var dateInput = $("satDateInput");
    var label = $("satDateLabel");
    var note = $("satNote");
    var row = $("satDateRow");
    var toggle = $("satToggle");
    var body = $("satBody");
    // Collapsible satellite panel: start collapsed on small screens to keep the map usable.
    if (toggle && body) {
      var startCollapsed = window.innerWidth <= 860;
      body.hidden = startCollapsed;
      toggle.setAttribute("aria-expanded", startCollapsed ? "false" : "true");
      toggle.addEventListener("click", function () {
        var willHide = !body.hidden;
        body.hidden = willHide;
        toggle.setAttribute("aria-expanded", willHide ? "false" : "true");
      });
    }

    var bounds = satDateBounds();
    range.min = String(bounds.min.getTime());
    range.max = String(bounds.max.getTime());
    range.step = String(24 * 60 * 60 * 1000);
    dateInput.min = toISODate(bounds.min);
    dateInput.max = toISODate(bounds.max);

    state.sat.date = new Date(bounds.max.getTime());
    range.value = String(bounds.max.getTime());
    dateInput.value = toISODate(bounds.max);
    label.textContent = formatLongDate(bounds.max);

    function syncFromDate(d) {
      state.sat.date = new Date(d.getTime());
      range.value = String(d.getTime());
      dateInput.value = toISODate(d);
      var eff = effectiveSatDate();
      label.textContent = formatLongDate(eff);
      if (state.sat.type === "ndvi" && d > ndviMaxDate()) {
        note.hidden = false;
        note.textContent = "NDVI is published monthly with a lag. Showing the latest available month (" + formatLongDate(eff) + ").";
      } else if (state.sat.type === "ndvi") {
        note.hidden = false;
        note.textContent = "Vegetation (NDVI) monthly composite for " + formatLongDate(eff) + ".";
      } else {
        note.hidden = true;
        note.textContent = "";
      }
    }

    var debouncedUpdate = debounce(function () { updateSatLayer(); }, 250);

    select.addEventListener("change", function () {
      state.sat.type = select.value;
      state.sat.tileErrors = 0;
      if (state.sat.type === "none") {
        row.hidden = true;
        note.hidden = true;
      } else {
        row.hidden = false;
        if (state.sat.type === "ndvi") {
          var max = ndviMaxDate();
          if (state.sat.date > max) {
            syncFromDate(max);
          } else {
            syncFromDate(state.sat.date);
          }
        } else {
          syncFromDate(state.sat.date);
        }
      }
      updateSatLayer();
    });

    range.addEventListener("input", function () {
      var d = new Date(Number(range.value));
      syncFromDate(d);
      debouncedUpdate();
    });

    dateInput.addEventListener("change", function () {
      var d = fromISODate(dateInput.value);
      if (!d) return;
      if (d < bounds.min) d = new Date(bounds.min.getTime());
      if (d > bounds.max) d = new Date(bounds.max.getTime());
      syncFromDate(d);
      updateSatLayer();
    });
  }

  function updateSatLayer() {
    if (!map) return;
    if (state.sat.layer) {
      map.removeLayer(state.sat.layer);
      state.sat.layer = null;
    }
    if (state.sat.type === "none") return;

    var eff = effectiveSatDate();
    var url, maxNativeZoom;
    if (state.sat.type === "truecolor") {
      // GIBS TrueColor supports GoogleMapsCompatible_Level9 (maxNativeZoom 9).
      url = "https://gibs.earthdata.nasa.gov/wmts/epsg3857/best/MODIS_Terra_CorrectedReflectance_TrueColor/default/" +
        toISODate(eff) + "/GoogleMapsCompatible_Level9/{z}/{y}/{x}.jpg";
      maxNativeZoom = 9;
    } else {
      // NOTE: GIBS NDVI only supports GoogleMapsCompatible_Level7 (not Level9).
      // Using Level9 returns 400 TILEMATRIXSET errors. Level7 is the correct set.
      var ndviDate = eff.getFullYear() + "-" + pad2(eff.getMonth() + 1) + "-01";
      url = "https://gibs.earthdata.nasa.gov/wmts/epsg3857/best/MODIS_Terra_L3_NDVI_Monthly/default/" +
        ndviDate + "/GoogleMapsCompatible_Level7/{z}/{y}/{x}.png";
      maxNativeZoom = 7;
    }

    var layer = L.tileLayer(url, {
      maxNativeZoom: maxNativeZoom,
      opacity: 1,
      attribution: "Imagery © NASA GIBS, MODIS Terra"
    });
    layer.on("tileerror", function () {
      state.sat.tileErrors++;
      // Avoid console flood: Leaflet does not log tile errors by default.
      // After several failures, hint that this date may have no imagery.
      if (state.sat.tileErrors === 12) {
        var note = $("satNote");
        if (note) {
          note.hidden = false;
          note.textContent = "Some tiles are missing for this date. Try a different date — not every day has imagery.";
        }
      }
    });
    layer.addTo(map);
    state.sat.layer = layer;
  }

  /* ---------- EPIC header photo ---------- */

  function getStoredKey() {
    // Key comes from env.js (window.EARTH_CASE_FILES_NASA_KEY, sourced from .env).
    // Falls back to DEMO_KEY if env.js is missing so the site still loads.
    try {
      var k = window.EARTH_CASE_FILES_NASA_KEY;
      if (k && String(k).trim()) return String(k).trim();
    } catch (e) { /* fall through to DEMO_KEY */ }
    return "DEMO_KEY";
  }

  function loadEpic() {
    state.epicKey = getStoredKey();
    var wrap = $("epicWrap"), img = $("epicImg"), caption = $("epicCaption");
    if (!wrap || !img) return;
    wrap.hidden = true;

    var url = "https://api.nasa.gov/EPIC/api/natural?api_key=" + encodeURIComponent(state.epicKey);
    fetch(url)
      .then(function (res) {
        if (!res.ok) throw new Error("EPIC " + res.status);
        return res.json();
      })
      .then(function (items) {
        if (!items || !items.length) throw new Error("No EPIC items");
        var item = items[0];
        var datePart = String(item.date).slice(0, 10);
        var parts = datePart.split("-");
        if (parts.length !== 3) throw new Error("Bad EPIC date");
        var imgUrl = "https://epic.gsfc.nasa.gov/archive/natural/" + parts[0] + "/" + parts[1] + "/" + parts[2] + "/jpg/" + item.image + ".jpg";
        img.onload = function () {
          wrap.hidden = false;
          var d = fromISODate(datePart);
          caption.textContent = d ? ("Earth from DSCOVR EPIC — " + formatLongDate(d)) : "Earth from DSCOVR EPIC";
        };
        img.onerror = function () { wrap.hidden = true; };
        img.src = imgUrl;
      })
      .catch(function () {
        // Hide cleanly — no broken image.
        wrap.hidden = true;
      });
  }

  /* ---------- Init ---------- */

  function init() {
    // Friendly wording for touch devices.
    try {
      var isTouch = ("ontouchstart" in window) || (navigator.maxTouchPoints > 0);
      var hint = $("hintText");
      if (hint && isTouch) hint.textContent = "Tap anywhere on Earth to open a case file";
    } catch (e) { /* keep default hint */ }
    initMap();
    initTabs();
    initToggles();
    initPresets();
    initSatControls();
    loadEpic();

    // Open Chattogram as the first case so the panel is never blank.
    // Map stays on the world view; the marker shows where the case is.
    setTimeout(function () {
      openPlace("A", 22.34, 91.83);
    }, 400);
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();
