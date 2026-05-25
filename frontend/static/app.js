const state = {
  items: [],
  selectedEventId: null,
  selectedRasterAsset: null,
  rasterMeta: null,
  timestamps: [],
  timeIndex: 0,
  playbackTimer: null,
  rasterVisible: true,
  landslidesVisible: true,
  selectedFeature: null,
  currentGeoJson: null,
  rasterRequestId: 0,
  vectorRequestId: 0,
};

const dom = {
  eventList: document.getElementById("event-list"),
  rasterList: document.getElementById("raster-list"),
  summaryEvent: document.getElementById("summary-event"),
  summaryLandslides: document.getElementById("summary-landslides"),
  summaryRegion: document.getElementById("summary-region"),
  summaryStep: document.getElementById("summary-step"),
  mapEventName: document.getElementById("map-event-name"),
  mapTimestamp: document.getElementById("map-timestamp"),
  currentTime: document.getElementById("current-time"),
  timeSlider: document.getElementById("time-slider"),
  tickStart: document.getElementById("tick-start"),
  tickMid: document.getElementById("tick-mid"),
  tickEnd: document.getElementById("tick-end"),
  playBtn: document.getElementById("play-btn"),
  pauseBtn: document.getElementById("pause-btn"),
  prevBtn: document.getElementById("prev-btn"),
  nextBtn: document.getElementById("next-btn"),
  toggleRaster: document.getElementById("toggle-raster"),
  toggleLandslides: document.getElementById("toggle-landslides"),
  zoomIn: document.getElementById("zoom-in"),
  zoomOut: document.getElementById("zoom-out"),
  zoomFit: document.getElementById("zoom-fit"),
  landslideEmpty: document.getElementById("landslide-empty"),
  landslideDetails: document.getElementById("landslide-details"),
  legendTitle: document.getElementById("legend-title"),
  legendBar: document.getElementById("legend-bar"),
  legendLabels: document.getElementById("legend-labels"),
  mapStatus: document.getElementById("map-status"),
  timeseriesLayer: document.getElementById("timeseries-layer"),
  chartLine: document.getElementById("chart-line"),
};

const map = L.map("map", {
  zoomControl: false,
  attributionControl: false,
}).setView([23.7, 121.0], 7);

map.createPane("landslides");
map.getPane("landslides").style.zIndex = "450";

L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
  maxZoom: 18,
}).addTo(map);

let rasterOverlay = null;
let landslideLayer = null;

initialize();

async function initialize() {
  bindEvents();
  setStatus("Loading events...");

  try {
    const response = await fetchJson("/api/items");
    state.items = response.items || [];
    renderEventCards();

    if (!state.items.length) {
      setStatus("No events available.");
      return;
    }

    await selectEvent(state.items[0].id);
    clearStatus();
  } catch (error) {
    console.error(error);
    setStatus("Unable to load initial data.");
  }
}

function bindEvents() {
  window.addEventListener("resize", () => map.invalidateSize());

  dom.timeSlider.addEventListener("input", async (event) => {
    const nextIndex = Number(event.target.value);
    await setTimeIndex(nextIndex);
  });

  dom.playBtn.addEventListener("click", () => startPlayback());
  dom.pauseBtn.addEventListener("click", () => stopPlayback());
  dom.prevBtn.addEventListener("click", async () => {
    stopPlayback();
    await setTimeIndex(Math.max(0, state.timeIndex - 1));
  });
  dom.nextBtn.addEventListener("click", async () => {
    stopPlayback();
    await setTimeIndex(Math.min(state.timestamps.length - 1, state.timeIndex + 1));
  });

  dom.toggleRaster.addEventListener("click", () => {
    state.rasterVisible = !state.rasterVisible;
    dom.toggleRaster.classList.toggle("on", state.rasterVisible);
    updateRasterVisibility();
  });

  dom.toggleLandslides.addEventListener("click", () => {
    state.landslidesVisible = !state.landslidesVisible;
    dom.toggleLandslides.classList.toggle("on", state.landslidesVisible);
    updateLandslideVisibility();
  });

  dom.zoomIn.addEventListener("click", () => map.zoomIn());
  dom.zoomOut.addEventListener("click", () => map.zoomOut());
  dom.zoomFit.addEventListener("click", () => fitSelectedEventBounds());
}

async function selectEvent(eventId) {
  if (state.selectedEventId === eventId) {
    return;
  }

  stopPlayback();
  state.selectedEventId = eventId;
  state.selectedFeature = null;
  renderEventCards();
  updateLandslideInfo(null);

  const selectedEvent = getSelectedEvent();
  const rasterAssets = Object.keys(selectedEvent?.assets?.rasters || {});
  state.selectedRasterAsset = rasterAssets.includes("maxdbz") ? "maxdbz" : rasterAssets[0] || null;

  renderRasterChips();
  await loadEventData();
}

async function selectRaster(assetName) {
  if (!assetName || state.selectedRasterAsset === assetName) {
    return;
  }

  stopPlayback();
  state.selectedRasterAsset = assetName;
  state.timeIndex = 0;
  renderRasterChips();
  await loadRasterData();
}

async function loadEventData() {
  const event = getSelectedEvent();
  if (!event || !state.selectedRasterAsset) {
    return;
  }

  dom.mapEventName.textContent = event.title;
  dom.summaryEvent.textContent = event.title;
  dom.summaryRegion.textContent = event.properties?.["event:country"] || "Taiwan";
  dom.timeseriesLayer.textContent = state.selectedRasterAsset.toUpperCase();
  await Promise.all([loadVectorData(), loadRasterData()]);
  fitSelectedEventBounds();
}

async function loadVectorData() {
  const eventId = state.selectedEventId;
  const requestId = state.vectorRequestId + 1;
  state.vectorRequestId = requestId;

  try {
    const geojson = await fetchJson(`/api/items/${eventId}/vector?asset=landslides`);
    if (requestId !== state.vectorRequestId || eventId !== state.selectedEventId) {
      return;
    }
    state.currentGeoJson = geojson;
    renderLandslides(geojson);
    dom.summaryLandslides.textContent = String(geojson.features?.length || 0);
  } catch (error) {
    if (requestId !== state.vectorRequestId || eventId !== state.selectedEventId) {
      return;
    }
    console.error(error);
    state.currentGeoJson = null;
    dom.summaryLandslides.textContent = "0";
    if (landslideLayer) {
      map.removeLayer(landslideLayer);
      landslideLayer = null;
    }
    setStatus("Unable to load landslide polygons.");
  }
}

async function loadRasterData() {
  const eventId = state.selectedEventId;
  const asset = state.selectedRasterAsset;
  const requestId = state.rasterRequestId + 1;
  state.rasterRequestId = requestId;

  if (!eventId || !asset) {
    return;
  }

  setStatus(`Loading ${asset}...`);
  dom.timeseriesLayer.textContent = formatAssetName(asset);

  try {
    const [metaResponse, timestampResponse] = await Promise.all([
      fetchJson(`/api/items/${eventId}/raster/meta?asset=${encodeURIComponent(asset)}`),
      fetchJson(`/api/items/${eventId}/timestamps?asset=${encodeURIComponent(asset)}`),
    ]);
    if (
      requestId !== state.rasterRequestId ||
      eventId !== state.selectedEventId ||
      asset !== state.selectedRasterAsset
    ) {
      return;
    }

    state.rasterMeta = metaResponse;
    state.timestamps = timestampResponse.timestamps || metaResponse.timestamps || [];
    state.timeIndex = Math.min(state.timeIndex, Math.max(0, state.timestamps.length - 1));
    updateLegend();
    updateTimeControls();
    updateChartLine();
    await refreshRasterOverlay();
    clearStatus();
  } catch (error) {
    if (
      requestId !== state.rasterRequestId ||
      eventId !== state.selectedEventId ||
      asset !== state.selectedRasterAsset
    ) {
      return;
    }
    console.error(error);
    state.rasterMeta = null;
    state.timestamps = [];
    updateLegend();
    updateTimeControls();
    removeRasterOverlay();
    setStatus(`Unable to load raster metadata for ${asset}.`);
  }
}

function renderEventCards() {
  dom.eventList.innerHTML = "";

  state.items.forEach((item) => {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "event-card";
    if (item.id === state.selectedEventId) {
      button.classList.add("active");
    }

    const rasterCount = Object.keys(item.assets?.rasters || {}).length;
    const hasLandslides = item.assets?.landslides ? "Yes" : "No";
    button.innerHTML = `
      <div class="event-name">${escapeHtml(item.title)}</div>
      <div class="event-meta">Raster layers: ${rasterCount}<br />Landslides: ${hasLandslides}</div>
    `;
    button.addEventListener("click", async () => {
      await selectEvent(item.id);
    });
    dom.eventList.appendChild(button);
  });
}

function renderRasterChips() {
  dom.rasterList.innerHTML = "";
  const rasters = getSelectedEvent()?.assets?.rasters || {};

  Object.keys(rasters).forEach((assetName) => {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "chip";
    button.textContent = formatAssetName(assetName);
    if (assetName === state.selectedRasterAsset) {
      button.classList.add("active");
    }
    button.addEventListener("click", async () => {
      await selectRaster(assetName);
    });
    dom.rasterList.appendChild(button);
  });
}

function renderLandslides(geojson) {
  if (landslideLayer) {
    map.removeLayer(landslideLayer);
  }

  landslideLayer = L.geoJSON(geojson, {
    pane: "landslides",
    style: (feature) => landslideStyle(feature, state.selectedFeature),
    onEachFeature: (feature, layer) => {
      layer.on("click", () => {
        state.selectedFeature = feature;
        updateLandslideInfo(feature.properties || {});
        refreshLandslideStyles();
      });
    },
  });

  updateLandslideVisibility();
  landslideLayer.bringToFront();
}

function landslideStyle(feature, selectedFeature) {
  const selected = selectedFeature && feature === selectedFeature;
  return {
    color: selected ? "#ffd34f" : "#ff7ab6",
    weight: 3,
    fillColor: selected ? "#f7931e" : "#ff4da0",
    fillOpacity: selected ? 0.58 : 0.28,
  };
}

function refreshLandslideStyles() {
  if (!landslideLayer) {
    return;
  }

  landslideLayer.setStyle((feature) => landslideStyle(feature, state.selectedFeature));
}

function updateLandslideInfo(properties) {
  if (!properties) {
    dom.landslideEmpty.classList.remove("hidden");
    dom.landslideDetails.classList.add("hidden");
    dom.landslideDetails.innerHTML = "";
    return;
  }

  const pairs = buildLandslidePairs(properties);
  dom.landslideDetails.innerHTML = "";
  pairs.forEach(([key, value]) => {
    const keyNode = document.createElement("div");
    keyNode.className = "key";
    keyNode.textContent = key;

    const valueNode = document.createElement("div");
    valueNode.className = "value";
    valueNode.textContent = value;

    dom.landslideDetails.appendChild(keyNode);
    dom.landslideDetails.appendChild(valueNode);
  });

  dom.landslideEmpty.classList.add("hidden");
  dom.landslideDetails.classList.remove("hidden");
}

function buildLandslidePairs(properties) {
  const entries = [];
  const knownFields = [
    ["ID", properties.fid ?? "-"],
    ["Area", formatArea(properties.Area_ha)],
    ["Time", properties.AfterDate || properties.BeforeDate || "-"],
    ["Event", properties.Events || "-"],
    ["Source", properties.DataSource || "-"],
  ];

  knownFields.forEach(([label, value]) => entries.push([label, String(value)]));

  Object.entries(properties).forEach(([key, value]) => {
    if (["fid", "Area_ha", "AfterDate", "BeforeDate", "Events", "DataSource"].includes(key)) {
      return;
    }
    if (entries.length >= 10) {
      return;
    }
    entries.push([key, stringifyValue(value)]);
  });

  return entries;
}

async function setTimeIndex(index) {
  if (!state.timestamps.length) {
    return;
  }

  const boundedIndex = Math.max(0, Math.min(index, state.timestamps.length - 1));
  state.timeIndex = boundedIndex;
  dom.timeSlider.value = String(boundedIndex);
  updateTimeLabels();
  await refreshRasterOverlay();
}

async function refreshRasterOverlay() {
  removeRasterOverlay();

  if (!state.rasterVisible || !state.rasterMeta?.bounds || !state.selectedEventId || !state.selectedRasterAsset) {
    return;
  }

  const bounds = toLeafletBounds(state.rasterMeta.bounds);
  const url = `/api/items/${state.selectedEventId}/raster/frame?asset=${encodeURIComponent(state.selectedRasterAsset)}&time_index=${state.timeIndex}&t=${Date.now()}`;

  rasterOverlay = L.imageOverlay(url, bounds, { opacity: 0.84, interactive: false });
  rasterOverlay.addTo(map);
  rasterOverlay.on("error", () => {
    removeRasterOverlay();
    setStatus("Raster frame unavailable. Metadata and timestamps are still loaded.");
  });
}

function removeRasterOverlay() {
  if (rasterOverlay) {
    map.removeLayer(rasterOverlay);
    rasterOverlay = null;
  }
}

function updateRasterVisibility() {
  if (!state.rasterVisible) {
    removeRasterOverlay();
    return;
  }
  refreshRasterOverlay();
}

function updateLandslideVisibility() {
  if (!landslideLayer) {
    return;
  }

  if (state.landslidesVisible) {
    if (!map.hasLayer(landslideLayer)) {
      landslideLayer.addTo(map);
    }
  } else if (map.hasLayer(landslideLayer)) {
    map.removeLayer(landslideLayer);
  }
}

function fitSelectedEventBounds() {
  const event = getSelectedEvent();
  const bounds = state.rasterMeta?.bounds || event?.bbox;
  if (!bounds) {
    return;
  }
  map.fitBounds(toLeafletBounds(bounds), { padding: [24, 24] });
}

function updateTimeControls() {
  const maxIndex = Math.max(0, state.timestamps.length - 1);
  dom.timeSlider.max = String(maxIndex);
  dom.timeSlider.value = String(Math.min(state.timeIndex, maxIndex));
  dom.timeSlider.disabled = state.timestamps.length <= 1;
  updateTimeLabels();
}

function updateTimeLabels() {
  const count = state.timestamps.length;
  const currentTimestamp = state.timestamps[state.timeIndex];
  const formattedCurrent = currentTimestamp ? formatTaipeiTimestamp(currentTimestamp) : "No timestamp loaded";

  dom.currentTime.textContent = formattedCurrent;
  dom.mapTimestamp.textContent = formattedCurrent;

  dom.tickStart.textContent = count ? shortTimestamp(state.timestamps[0]) : "Start";
  dom.tickMid.textContent = count ? shortTimestamp(state.timestamps[Math.floor((count - 1) / 2)]) : "Mid";
  dom.tickEnd.textContent = count ? shortTimestamp(state.timestamps[count - 1]) : "End";

  dom.summaryStep.textContent = count > 1 ? describeTimeStep(state.timestamps[0], state.timestamps[1]) : "-";
}

function updateLegend() {
  const asset = state.selectedRasterAsset || "raster";
  dom.legendTitle.textContent = `${formatAssetName(asset)} ${legendUnit(asset)}`.trim();
  dom.legendBar.className = `legend-bar ${legendClass(asset)}`;

  const labels = buildLegendLabels(asset, state.rasterMeta);
  dom.legendLabels.innerHTML = labels.map((label) => `<span>${escapeHtml(label)}</span>`).join("");
}

function updateChartLine() {
  const count = Math.max(state.timestamps.length, 3);
  const points = [];
  for (let index = 0; index < 16; index += 1) {
    const x = 20 + index * (220 / 15);
    const wave = Math.sin((index / 15) * Math.PI * 2) * 28;
    const drift = ((index / 15) * 42) - (state.timeIndex % 7) * 2;
    const y = Math.max(28, Math.min(120, 110 - wave - drift));
    points.push(`${x.toFixed(1)},${y.toFixed(1)}`);
  }
  dom.chartLine.setAttribute("points", points.join(" "));
}

function startPlayback() {
  if (state.playbackTimer) {
    updatePlaybackButtons(true);
    return;
  }

  if (state.timestamps.length <= 1) {
    updatePlaybackButtons(false);
    return;
  }

  updatePlaybackButtons(true);
  state.playbackTimer = window.setInterval(async () => {
    const nextIndex = state.timeIndex >= state.timestamps.length - 1 ? 0 : state.timeIndex + 1;
    await setTimeIndex(nextIndex);
  }, 1200);
}

function stopPlayback() {
  if (state.playbackTimer) {
    window.clearInterval(state.playbackTimer);
    state.playbackTimer = null;
  }
  updatePlaybackButtons(false);
}

function updatePlaybackButtons(isPlaying) {
  dom.playBtn.classList.toggle("active", isPlaying);
  dom.pauseBtn.classList.toggle("active", !isPlaying);
}

function getSelectedEvent() {
  return state.items.find((item) => item.id === state.selectedEventId) || null;
}

function toLeafletBounds(bounds) {
  return [
    [bounds[1], bounds[0]],
    [bounds[3], bounds[2]],
  ];
}

async function fetchJson(url) {
  const response = await fetch(url);
  if (!response.ok) {
    const message = await response.text();
    throw new Error(`${response.status} ${message}`);
  }
  return response.json();
}

function formatTaipeiTimestamp(value) {
  const date = new Date(value);
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Taipei",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(date).replace(",", "") + " (UTC+8)";
}

function shortTimestamp(value) {
  const date = new Date(value);
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Taipei",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(date).replace(",", "");
}

function describeTimeStep(first, second) {
  const firstDate = new Date(first);
  const secondDate = new Date(second);
  const diffMinutes = Math.round((secondDate - firstDate) / 60000);
  if (!Number.isFinite(diffMinutes) || diffMinutes <= 0) {
    return "-";
  }
  if (diffMinutes % 60 === 0) {
    return `${diffMinutes / 60} hr`;
  }
  return `${diffMinutes} min`;
}

function formatAssetName(assetName) {
  return assetName.replaceAll("_", " ").toUpperCase();
}

function formatArea(value) {
  if (value === undefined || value === null || value === "") {
    return "-";
  }
  return `${Number(value).toLocaleString()} ha`;
}

function buildLegendLabels(assetName, meta) {
  if (meta?.vmin !== undefined && meta?.vmax !== undefined) {
    const steps = 4;
    const labels = [];
    for (let index = 0; index <= steps; index += 1) {
      const value = meta.vmin + ((meta.vmax - meta.vmin) * index) / steps;
      labels.push(Number.isInteger(value) ? `${value}` : value.toFixed(1));
    }
    return labels;
  }

  switch (assetName) {
    case "maxdbz":
      return ["-10", "10", "25", "40", "60"];
    case "rain_rate":
      return ["0", "15", "30", "60", "120"];
    case "accum_rainfall":
      return ["0", "50", "150", "300", "500"];
    default:
      return ["Low", "", "Mid", "", "High"];
  }
}

function legendClass(assetName) {
  if (assetName === "maxdbz") {
    return "radar";
  }
  if (assetName === "rain_rate" || assetName === "accum_rainfall") {
    return "rainfall";
  }
  return "grayscale";
}

function legendUnit(assetName) {
  switch (assetName) {
    case "maxdbz":
      return "(dBZ)";
    case "rain_rate":
      return "(mm/hr)";
    case "accum_rainfall":
      return "(mm)";
    default:
      return "";
  }
}

function stringifyValue(value) {
  if (value === null || value === undefined || value === "") {
    return "-";
  }
  if (Array.isArray(value)) {
    return value.join(", ");
  }
  return String(value);
}

function setStatus(message) {
  dom.mapStatus.textContent = message;
  dom.mapStatus.classList.remove("hidden");
}

function clearStatus() {
  dom.mapStatus.textContent = "";
  dom.mapStatus.classList.add("hidden");
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}
