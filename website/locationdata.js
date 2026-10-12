// Coordinates are Unreal world "X Y Z" (same order as in-game).
// LocationData.json is the single master: chunk LocationData + PCG foliage, map-bounds filtered.
const DATA_URL_CANDIDATES = [
  "/tools/LocationData/LocationData.json"
];
const DYNAMIC_DATA_URL = "/tools/DynamicAISpawnData/DynamicAISpawnData.json";
const CONFIG_URL = "/data.config.json";
let ROOT_FOLDER = "0.11.0.3";
const MAX_RESULTS = 400;
const SEARCH_DEBOUNCE_MS = 90;
const MAX_MAP_MARKERS = 500;

const searchInput = document.getElementById("file-search");
const statusEl = document.getElementById("status");
const resultsEl = document.getElementById("results");
const resultsViewer = document.querySelector(".results-viewer");
const landingMessageEl = document.getElementById("landing-message");
const homeStatusEl = document.getElementById("home-status");
const homeSubtitleEl = document.getElementById("home-subtitle");
const selectedPathEl = document.getElementById("selected-path");
const fileContentEl = document.getElementById("file-content");
const siteLogo = document.getElementById("site-logo");
const toolsToggleBtn = document.getElementById("tools-toggle");
const toolsDropdownEl = document.getElementById("tools-dropdown");
const combineBtn = document.getElementById("combine-btn");
const combinerModal = document.getElementById("combiner-modal");
const includeZInput = document.getElementById("include-z");
const combineNameInput = document.getElementById("combine-name");
const combineDescriptionInput = document.getElementById("combine-description");
const combineIconInput = document.getElementById("combine-icon");
const combineIconSizeInput = document.getElementById("combine-icon-size");
const combinerCancelBtn = document.getElementById("combiner-cancel");
const combinerCopyCenterBtn = document.getElementById("combiner-copy-center");
const combinerCreateBtn = document.getElementById("combiner-create");
const togglePreviewFormatBtn = document.getElementById("toggle-preview-format");
const copyPreviewBtn = document.getElementById("copy-preview");
const copyToastEl = document.getElementById("copy-toast");
const locationMapEl = document.getElementById("location-map");
const toggleMapModeBtn = document.getElementById("toggle-map-mode");

let locations = [];
let currentMatches = [];
let currentFiltered = [];
let selectedMatchIndex = -1;
let currentActiveBtn = null;
let debounceTimer = null;
let lastQuery = "";
let previewMode = "wiki";
let currentOpenEntry = null;
let copyToastTimer = null;
let locationMap = null;
let locationMarkersLayer = null;
let mapMode = "selected";
let fixedLocationCount = 0;
let dynamicLocationCount = 0;

if (siteLogo) {
  siteLogo.addEventListener("error", () => {
    siteLogo.style.opacity = "0.5";
    siteLogo.title = "Add website/logo.png to display your logo.";
  });
}

function escapeHtml(str) {
  return String(str)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

function formatSpawnInterval(seconds) {
  if (!Number.isFinite(seconds)) return "Not configured";
  if (seconds === 0) return "No configured delay";
  const minutes = Math.floor(seconds / 60);
  const remainder = Math.round(seconds % 60);
  if (!minutes) return `${remainder}s`;
  return remainder ? `${minutes}m ${remainder}s` : `${minutes}m`;
}

function getSpawnTierDetails(tierName, settings) {
  const name = tierName || "Unknown";
  if (!settings || typeof settings !== "object") {
    return { name, density: null, interval: null, cap: null };
  }
  if (settings.mode === "always") {
    return { name, density: "Always eligible", interval: null, cap: null };
  }
  if (settings.mode === "never") {
    return { name, density: "Disabled", interval: null, cap: "0" };
  }

  const quantity = Number(settings.quantityPerSquareMeter);
  const areaPerCreature = quantity > 0 ? 1 / quantity : null;
  const intervalSeconds = Number(settings.spawnIntervalSeconds);
  const cap = Number(settings.creatureLimitPerPlayer);
  return {
    name,
    density: Number.isFinite(areaPerCreature)
      ? `1 per ${Math.round(areaPerCreature).toLocaleString()} m²`
      : null,
    interval: formatSpawnInterval(intervalSeconds),
    cap: Number.isFinite(cap) ? cap.toLocaleString() : null
  };
}

function renderSpawnTierPopup(encounters) {
  const uniqueTiers = new Map();
  for (const encounter of encounters || []) {
    const details = getSpawnTierDetails(encounter.rarity, encounter.spawnTier);
    const key = `${details.name}|${details.density}|${details.interval}|${details.cap}`;
    uniqueTiers.set(key, details);
  }
  return [...uniqueTiers.values()].map((details) => {
    const lines = [`<br/><strong>Spawn tier: ${escapeHtml(details.name)}</strong>`];
    if (details.density) lines.push(`<br/>Target density: ${escapeHtml(details.density)}`);
    if (details.interval) lines.push(`<br/>Configured interval: ${escapeHtml(details.interval)}`);
    if (details.cap) lines.push(`<br/>Per-player cap: ${escapeHtml(details.cap)}`);
    lines.push('<br/><span class="spawn-tier-note">Not a direct percentage chance.</span>');
    return lines.join("");
  }).join("");
}

async function loadWebsiteConfig() {
  try {
    const response = await fetch(CONFIG_URL, { cache: "no-store" });
    if (!response.ok) {
      return;
    }
    const parsed = await response.json();
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return;
    }
    if (typeof parsed.datasetVersion === "string" && parsed.datasetVersion.trim()) {
      ROOT_FOLDER = parsed.datasetVersion.trim();
    }
  } catch {
    // Keep defaults if config cannot be loaded.
  }
}

function updateStatus(text) {
  statusEl.textContent = text;
}

function updateHomeStatus(text) {
  homeStatusEl.textContent = text;
}

function updateHomeSubtitle(text) {
  homeSubtitleEl.textContent = text;
}

function setLandingVisible(visible) {
  landingMessageEl.hidden = !visible;
  statusEl.style.display = visible ? "none" : "block";
}


function setCombinerModal(open) {
  combinerModal.hidden = !open;
}

function updatePreviewControlsState() {
  const hasSelection = Boolean(currentOpenEntry);
  togglePreviewFormatBtn.disabled = !hasSelection;
  copyPreviewBtn.disabled = !hasSelection;
}

function getPreviewText(entry) {
  if (previewMode === "coords") {
    return `${entry.x} ${entry.y} ${entry.z}`;
  }

  const previewData = entry.kind === "dynamic"
    ? {
        type: "dynamicEncounterArea",
        displayName: entry.name,
        aiClass: entry.dynamic.aiClass,
        npcId: entry.dynamic.npcId,
        center: {
          x: toNumberOrString(entry.x),
          y: toNumberOrString(entry.y),
          z: toNumberOrString(entry.z)
        },
        bounds: entry.dynamic.bounds,
        cellCount: entry.dynamic.cellCount,
        volumeId: entry.dynamic.volumeId,
        spawnTable: entry.dynamic.spawnTable,
        tags: entry.dynamic.tags,
        encounters: entry.dynamic.encounters
      }
    : {
        x: toNumberOrString(entry.x),
        y: toNumberOrString(entry.y),
        z: toNumberOrString(entry.z)
      };
  return `${JSON.stringify(previewData, null, 2)}\n`;
}

function updatePreviewModeButtonLabel() {
  if (currentOpenEntry && currentOpenEntry.kind === "dynamic") {
    togglePreviewFormatBtn.textContent = previewMode === "wiki" ? "Details" : "Center";
    return;
  }
  togglePreviewFormatBtn.textContent = previewMode === "wiki" ? "Wiki" : "Coords";
}

function showCopyToast(message, isError = false) {
  if (!copyToastEl) {
    return;
  }
  if (copyToastTimer) {
    clearTimeout(copyToastTimer);
  }
  copyToastEl.textContent = message;
  copyToastEl.classList.toggle("error", isError);
  copyToastEl.hidden = false;
  requestAnimationFrame(() => {
    copyToastEl.classList.add("show");
  });
  copyToastTimer = setTimeout(() => {
    copyToastEl.classList.remove("show");
    setTimeout(() => {
      copyToastEl.hidden = true;
    }, 200);
  }, 1800);
}

function updateCombineButtonState() {
  const count = currentFiltered.filter((entry) => entry.kind !== "dynamic").length;
  combineBtn.disabled = count === 0;
  combineBtn.textContent = count > 0 ? `Combine (${count.toLocaleString()})` : "Combine";
}

function updateMapModeButtonLabel() {
  if (!toggleMapModeBtn) {
    return;
  }
  toggleMapModeBtn.textContent = mapMode === "selected" ? "Map: Selected" : "Map: Filtered";
}

function initLocationMap() {
  if (!locationMapEl || typeof window.L === "undefined") {
    return;
  }
  if (locationMap) {
    return;
  }

  locationMap = window.RSDW_MAP_CALIBRATION.createLeafletMap(locationMapEl, {
    zoom: 2,
    minZoom: 0.5,
    maxZoom: 4,
    zoomSnap: 0.5
  });

  locationMarkersLayer = window.L.layerGroup().addTo(locationMap);
}

function entryToLatLng(entry) {
  const x = Number.parseFloat(String(entry.x));
  const y = Number.parseFloat(String(entry.y));
  if (!Number.isFinite(x) || !Number.isFinite(y)) {
    return null;
  }
  // Dragonwilds map works as lat=y, lng=x (same axis swap used by wiki center examples).
  return [y, x];
}

function syncMapMarkers() {
  if (!locationMap || !locationMarkersLayer) {
    return;
  }

  locationMarkersLayer.clearLayers();
  const sourceEntries = mapMode === "filtered"
    ? currentFiltered.slice(0, MAX_MAP_MARKERS)
    : (currentOpenEntry ? [currentOpenEntry] : []);
  const bounds = [];

  for (const entry of sourceEntries) {
    const latLng = entryToLatLng(entry);
    if (!latLng) {
      continue;
    }
    if (entry.kind === "dynamic" && entry.dynamic && entry.dynamic.bounds) {
      const minimum = entry.dynamic.bounds.min;
      const maximum = entry.dynamic.bounds.max;
      const areaBounds = [
        [Number(minimum.y), Number(minimum.x)],
        [Number(maximum.y), Number(maximum.x)]
      ];
      if (areaBounds.flat().every(Number.isFinite)) {
        bounds.push(areaBounds[0], areaBounds[1]);
        const popup = `<strong class="map-popup-title">${escapeHtml(entry.name)}</strong>`
          + `<br/>Dynamic encounter area`
          + `<br/>${entry.dynamic.cellCount.toLocaleString()} candidate cells`
          + renderSpawnTierPopup(entry.dynamic.encounters);
        window.L.rectangle(areaBounds, {
          color: "#e0c896",
          weight: 2,
          fillColor: "#e0c896",
          fillOpacity: 0.14
        }).bindPopup(popup).addTo(locationMarkersLayer);
        window.L.circleMarker(latLng, {
          radius: 4,
          color: "#f4dfad",
          weight: 2,
          fillColor: "#0c0c0f",
          fillOpacity: 0.9
        }).bindPopup(popup).addTo(locationMarkersLayer);
        continue;
      }
    }

    bounds.push(latLng);
    window.L.marker(latLng)
      .bindPopup(
        `<strong class="map-popup-title">${escapeHtml(entry.name)}</strong><br/>X: ${escapeHtml(String(entry.x))}<br/>Y: ${escapeHtml(String(entry.y))}`
      )
      .addTo(locationMarkersLayer);
  }

  if (!bounds.length) {
    return;
  }

  if (mapMode === "selected") {
    if (currentOpenEntry && currentOpenEntry.kind === "dynamic" && bounds.length > 1) {
      locationMap.fitBounds(bounds, { padding: [28, 28], maxZoom: 3.5 });
    } else {
      const selectedLatLng = currentOpenEntry ? entryToLatLng(currentOpenEntry) : bounds[0];
      const [lat, lng] = selectedLatLng || bounds[0];
      locationMap.setView([lat, lng], Math.max(locationMap.getZoom(), 2.5));
    }
    const firstLayer = locationMarkersLayer.getLayers()[0];
    if (firstLayer && typeof firstLayer.openPopup === "function") {
      firstLayer.openPopup();
    }
  } else {
    locationMap.fitBounds(bounds, { padding: [24, 24] });
  }

  locationMap.invalidateSize();
}

function setActiveButton(buttonEl) {
  if (currentActiveBtn) {
    currentActiveBtn.classList.remove("active");
  }
  if (buttonEl) {
    buttonEl.classList.add("active");
  }
  currentActiveBtn = buttonEl;
}

function setSelectedMatch(index) {
  if (currentMatches.length === 0) {
    selectedMatchIndex = -1;
    setActiveButton(null);
    return;
  }

  selectedMatchIndex = Math.max(0, Math.min(index, currentMatches.length - 1));
  const button = resultsEl.querySelector(`button[data-idx="${selectedMatchIndex}"]`);
  if (!button) {
    return;
  }

  setActiveButton(button);
  button.scrollIntoView({ block: "nearest" });
}

function openLocation(entry) {
  currentOpenEntry = entry;
  selectedPathEl.textContent = entry.kind === "dynamic"
    ? `${entry.name} - Dynamic encounter area`
    : entry.name;
  fileContentEl.textContent = getPreviewText(entry);
  updatePreviewModeButtonLabel();
  updatePreviewControlsState();
  syncMapMarkers();
}

function openMatchByIndex(index) {
  if (index < 0 || index >= currentMatches.length) {
    return;
  }
  setSelectedMatch(index);
  openLocation(currentMatches[index]);
}

function parseCoordinates(value) {
  const parts = String(value).trim().split(/\s+/);
  const [x = "", y = "", z = ""] = parts;
  return { x, y, z };
}

function toNumberOrString(value) {
  const parsed = Number.parseFloat(String(value));
  return Number.isFinite(parsed) ? parsed : value;
}

function sanitizeForFilename(input) {
  const cleaned = input
    .trim()
    .replaceAll(/\s+/g, "")
    .replaceAll(/[^a-zA-Z0-9_-]/g, "");
  return cleaned || "combined";
}

const DEFAULT_ICON_SIZE_PAIR = [50, 50];

/**
 * Parse "60, 60" / "50,50" into [w, h]. Non-positive or invalid input falls back to DEFAULT_ICON_SIZE_PAIR.
 * @param {string} raw
 * @returns {[number, number]}
 */
function parseIconSizeString(raw) {
  const s = String(raw || "").trim();
  if (!s) {
    return [...DEFAULT_ICON_SIZE_PAIR];
  }
  const parts = s.split(/[,;]/u).map((p) => p.trim()).filter((p) => p.length > 0);
  if (parts.length !== 2) {
    return [...DEFAULT_ICON_SIZE_PAIR];
  }
  const w = Number.parseInt(parts[0], 10);
  const h = Number.parseInt(parts[1], 10);
  if (!Number.isFinite(w) || !Number.isFinite(h) || w < 1 || h < 1) {
    return [...DEFAULT_ICON_SIZE_PAIR];
  }
  return [w, h];
}

/**
 * Keep icon size field to digits, commas, and spaces so users cannot type letters.
 * @param {string} value
 * @returns {string}
 */
function filterIconSizeInputValue(value) {
  return value.replaceAll(/[^0-9,;\s]/gu, "");
}

function downloadCombinedLocationData() {
  const includeZ = includeZInput.checked;
  const nameRaw = combineNameInput && combineNameInput.value.trim();
  const descriptionRaw = combineDescriptionInput && combineDescriptionInput.value.trim();
  const iconNameRaw = combineIconInput && combineIconInput.value.trim();
  const iconSizePair = parseIconSizeString(
    combineIconSizeInput ? combineIconSizeInput.value : ""
  );
  const includeIcon = Boolean(iconNameRaw);

  const payload = currentFiltered.filter((entry) => entry.kind !== "dynamic").map((entry) => {
    const out = {
      x: toNumberOrString(entry.x),
      y: toNumberOrString(entry.y)
    };
    if (includeZ) {
      out.z = toNumberOrString(entry.z);
    }
    if (nameRaw) {
      out.name = nameRaw;
    }
    if (descriptionRaw) {
      out.description = descriptionRaw;
    }
    if (includeIcon) {
      out.icon = iconNameRaw;
      out.iconSize = iconSizePair;
    }
    return out;
  });

  const fileName = `${sanitizeForFilename(lastQuery)}LocationData.json`;
  const blob = new Blob([`${JSON.stringify(payload, null, 2)}\n`], { type: "application/json;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = fileName;
  document.body.appendChild(anchor);
  anchor.click();
  document.body.removeChild(anchor);
  URL.revokeObjectURL(url);
}

function renderResults(matches) {
  resultsEl.innerHTML = "";
  currentActiveBtn = null;

  if (matches.length === 0) {
    const li = document.createElement("li");
    li.textContent = "No matching locations.";
    li.style.color = "var(--muted)";
    li.style.padding = "0.75rem";
    resultsEl.appendChild(li);
    return;
  }

  const fragment = document.createDocumentFragment();
  matches.forEach((entry, idx) => {
    const li = document.createElement("li");
    const btn = document.createElement("button");
    btn.className = "location-result-button";
    const name = document.createElement("span");
    name.className = "location-result-name";
    name.textContent = entry.name;
    btn.appendChild(name);
    if (entry.kind === "dynamic") {
      const meta = document.createElement("span");
      meta.className = "location-result-meta";
      meta.textContent = `Dynamic area · ${entry.dynamic.rarityLabel} spawn tier · ${entry.dynamic.cellCount.toLocaleString()} cells`;
      btn.appendChild(meta);
    }
    btn.title = entry.name;
    btn.type = "button";
    btn.dataset.idx = String(idx);
    btn.addEventListener("click", () => openMatchByIndex(idx));
    li.appendChild(btn);
    fragment.appendChild(li);
  });
  resultsEl.appendChild(fragment);
}

function locationEntryMatchesQuery(entry, queryRaw) {
  const fn = window.rsdwHaystackMatchesQuery;
  const hay = entry.searchHaystack || `${entry.nameLower} ${entry.coordsLower}`;
  if (typeof fn === "function") {
    return fn(hay, queryRaw);
  }
  const query = String(queryRaw || "").trim().toLowerCase();
  return hay.includes(query);
}

function filterAndRender() {
  const queryRaw = searchInput.value.trim();
  const query = queryRaw.toLowerCase();
  lastQuery = queryRaw;
  if (!query) {
    currentMatches = [];
    currentFiltered = [];
    selectedMatchIndex = -1;
    currentOpenEntry = null;
    setActiveButton(null);
    resultsViewer.classList.remove("visible");
    setLandingVisible(true);
    resultsEl.innerHTML = "";
    selectedPathEl.textContent = "Select a location";
    fileContentEl.textContent = "Search and click a location to preview XYZ coordinates.";
    updatePreviewControlsState();
    updatePreviewModeButtonLabel();
    updateCombineButtonState();
    syncMapMarkers();
    return;
  }

  const matches = locations.filter((entry) => locationEntryMatchesQuery(entry, queryRaw));
  currentFiltered = matches;
  currentMatches = matches.slice(0, MAX_RESULTS);
  renderResults(currentMatches);
  resultsViewer.classList.add("visible");
  setLandingVisible(false);
  setSelectedMatch(0);

  const capped = matches.length > MAX_RESULTS ? ` (showing first ${MAX_RESULTS.toLocaleString()})` : "";
  updateStatus(`${matches.length.toLocaleString()} matches${capped}.`);
  updateCombineButtonState();
  syncMapMarkers();
}

function triggerDebouncedSearch() {
  const hasInput = searchInput.value.trim().length > 0;
  setLandingVisible(!hasInput);

  if (debounceTimer) {
    clearTimeout(debounceTimer);
  }
  debounceTimer = setTimeout(filterAndRender, SEARCH_DEBOUNCE_MS);
}

/**
 * Unreal-style coordinate string for clipboard (same order as in-game: X Y Z).
 * @param {number} n
 * @returns {string}
 */
function formatLocationNumberForClipboard(n) {
  if (!Number.isFinite(n)) {
    return "0";
  }
  const s = n.toFixed(6).replace(/\.?0+$/u, "");
  return s || "0";
}

/**
 * Component-wise mean of all filtered points, as a wiki `Map` module fragment.
 * The `center` parameter is **Y then X** (map/wiki order), not Unreal `X Y` order.
 * @param {boolean} includeZ
 * @returns {string | null} e.g. `|center=139237.686757,61172.214662` (Y,X), or null if nothing valid.
 */
function computeFilteredCenterLocationString(includeZ) {
  const entries = currentFiltered.filter((entry) => entry.kind !== "dynamic");
  if (entries.length === 0) {
    return null;
  }
  let sumX = 0;
  let sumY = 0;
  let sumZ = 0;
  let nX = 0;
  let nY = 0;
  let nZ = 0;
  for (const e of entries) {
    const x = Number.parseFloat(String(e.x));
    const y = Number.parseFloat(String(e.y));
    const z = Number.parseFloat(String(e.z));
    if (Number.isFinite(x)) {
      sumX += x;
      nX += 1;
    }
    if (Number.isFinite(y)) {
      sumY += y;
      nY += 1;
    }
    if (Number.isFinite(z)) {
      sumZ += z;
      nZ += 1;
    }
  }
  if (nX === 0 || nY === 0) {
    return null;
  }
  const cx = sumX / nX;
  const cy = sumY / nY;
  const fx = formatLocationNumberForClipboard(cx);
  const fy = formatLocationNumberForClipboard(cy);
  if (!includeZ || nZ === 0) {
    return `|center=${fy},${fx}`;
  }
  const cz = sumZ / nZ;
  const fz = formatLocationNumberForClipboard(cz);
  return `|center=${fy},${fx},${fz}`;
}

async function copyFilteredCenterLocation() {
  const includeZ = Boolean(includeZInput && includeZInput.checked);
  const text = computeFilteredCenterLocationString(includeZ);
  if (text == null) {
    showCopyToast("No valid coordinates to average.", true);
    return;
  }
  try {
    await copyTextToClipboard(text);
    showCopyToast("Center location copied to clipboard.");
  } catch {
    showCopyToast("Unable to copy to clipboard.", true);
  }
}

async function copyTextToClipboard(text) {
  if (navigator.clipboard && window.isSecureContext) {
    await navigator.clipboard.writeText(text);
    return;
  }

  const textArea = document.createElement("textarea");
  textArea.value = text;
  textArea.style.position = "fixed";
  textArea.style.opacity = "0";
  document.body.appendChild(textArea);
  textArea.focus();
  textArea.select();
  document.execCommand("copy");
  document.body.removeChild(textArea);
}

async function handleCopyPreview() {
  if (!currentOpenEntry) {
    return;
  }

  try {
    await copyTextToClipboard(getPreviewText(currentOpenEntry));
    showCopyToast("Copied to clipboard.");
  } catch {
    showCopyToast("Unable to copy preview text.", true);
  }
}

function handleSearchKeyDown(event) {
  if (event.key === "Escape") {
    searchInput.value = "";
    filterAndRender();
    return;
  }

  if (!resultsViewer.classList.contains("visible") || currentMatches.length === 0) {
    return;
  }

  if (event.key === "ArrowDown") {
    event.preventDefault();
    setSelectedMatch(selectedMatchIndex + 1);
    return;
  }

  if (event.key === "ArrowUp") {
    event.preventDefault();
    setSelectedMatch(selectedMatchIndex - 1);
    return;
  }

  if (event.key === "Enter") {
    event.preventDefault();
    if (selectedMatchIndex >= 0) {
      openMatchByIndex(selectedMatchIndex);
    }
  }
}

async function loadLocationDataObject() {
  let lastError = null;
  for (const url of DATA_URL_CANDIDATES) {
    try {
      const response = await fetch(url, { cache: "no-store" });
      if (!response.ok) {
        lastError = new Error(`HTTP ${response.status} ${url}`);
        continue;
      }
      const parsed = await response.json();
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
        lastError = new Error(`Invalid LocationData JSON shape: ${url}`);
        continue;
      }
      return { parsed, url };
    } catch (e) {
      lastError = e instanceof Error ? e : new Error(String(e));
    }
  }
  throw lastError instanceof Error ? lastError : new Error("No LocationData JSON could be loaded");
}

async function loadDynamicAISpawnData() {
  try {
    const response = await fetch(DYNAMIC_DATA_URL, { cache: "no-store" });
    if (!response.ok) {
      throw new Error(`HTTP ${response.status} ${DYNAMIC_DATA_URL}`);
    }
    const payload = await response.json();
    if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
      throw new Error(`Invalid DynamicAISpawnData JSON shape: ${DYNAMIC_DATA_URL}`);
    }
    return payload;
  } catch (error) {
    console.warn("Dynamic AI encounter data is unavailable.", error);
    return null;
  }
}

function normalizeDynamicLocations(payload) {
  if (!payload || typeof payload !== "object") {
    return [];
  }
  const tables = payload.tables && typeof payload.tables === "object" ? payload.tables : {};
  const volumes = Array.isArray(payload.volumes) ? payload.volumes : [];
  const tierPayload = payload.spawnTierSettings && typeof payload.spawnTierSettings === "object"
    ? payload.spawnTierSettings
    : {};
  const tierSettings = tierPayload.tiers && typeof tierPayload.tiers === "object"
    ? tierPayload.tiers
    : {};
  const entries = [];

  for (const volume of volumes) {
    if (!volume || typeof volume !== "object" || !volume.center) {
      continue;
    }
    const table = tables[volume.spawnTable];
    const encounters = table && Array.isArray(table.encounters) ? table.encounters : [];
    const byAiClass = new Map();

    for (const encounter of encounters) {
      const members = encounter && Array.isArray(encounter.members) ? encounter.members : [];
      for (const member of members) {
        if (!member || typeof member.aiClass !== "string" || !member.aiClass) {
          continue;
        }
        if (!byAiClass.has(member.aiClass)) {
          byAiClass.set(member.aiClass, {
            aiClass: member.aiClass,
            npcId: member.npcId || null,
            displayName: member.displayName || member.aiClass,
            encounters: []
          });
        }
        byAiClass.get(member.aiClass).encounters.push({
          row: encounter.row,
          rarity: encounter.rarity,
          spawnTier: encounter.rarity && tierSettings[encounter.rarity]
            ? tierSettings[encounter.rarity]
            : null,
          chanceModifiers: encounter.chanceModifiers || [],
          spreadRadius: encounter.spreadRadius,
          minQuantity: member.minQuantity,
          maxQuantity: member.maxQuantity,
          powerLevel: member.powerLevel,
          spawnBehaviour: member.spawnBehaviour
        });
      }
    }

    for (const ai of byAiClass.values()) {
      const rarities = [...new Set(ai.encounters.map((item) => item.rarity).filter(Boolean))];
      const modifiers = [...new Set(ai.encounters.flatMap((item) => item.chanceModifiers || []))];
      const coords = `${volume.center.x} ${volume.center.y} ${volume.center.z}`;
      const searchParts = [
        ai.displayName,
        ai.aiClass,
        ai.npcId,
        volume.id,
        volume.spawnTable,
        ...(volume.tags || []),
        ...rarities,
        ...modifiers,
        ...ai.encounters.map((item) => item.row)
      ].filter(Boolean);
      entries.push({
        kind: "dynamic",
        name: ai.displayName,
        nameLower: ai.displayName.toLowerCase(),
        coords,
        coordsLower: coords.toLowerCase(),
        searchHaystack: `${searchParts.join(" ").toLowerCase()} ${coords.toLowerCase()}`,
        x: volume.center.x,
        y: volume.center.y,
        z: volume.center.z,
        dynamic: {
          aiClass: ai.aiClass,
          npcId: ai.npcId,
          volumeId: volume.id,
          spawnTable: volume.spawnTable,
          tags: volume.tags || [],
          bounds: volume.bounds,
          cellCount: Number(volume.cellCount) || 0,
          rarityLabel: rarities.join(", ") || "Variable rarity",
          encounters: ai.encounters
        }
      });
    }
  }

  return entries.sort((a, b) => a.name.localeCompare(b.name) || a.dynamic.volumeId.localeCompare(b.dynamic.volumeId));
}

async function init() {
  await loadWebsiteConfig();
  try {
    initLocationMap();

    const [{ parsed }, dynamicPayload] = await Promise.all([
      loadLocationDataObject(),
      loadDynamicAISpawnData()
    ]);

    const fixedLocations = Object.entries(parsed)
      .filter(([name]) => !name.startsWith("AISpawnVolume_UAID_"))
      .map(([name, coords]) => {
      const xyz = parseCoordinates(coords);
      return {
        kind: "fixed",
        name,
        nameLower: name.toLowerCase(),
        coords: String(coords),
        coordsLower: String(coords).toLowerCase(),
        searchHaystack: `${name.toLowerCase()} ${String(coords).toLowerCase()}`,
        x: xyz.x,
        y: xyz.y,
        z: xyz.z
      };
    });
    const dynamicLocations = normalizeDynamicLocations(dynamicPayload);
    locations = [...fixedLocations, ...dynamicLocations];
    fixedLocationCount = fixedLocations.length;
    dynamicLocationCount = dynamicLocations.length;

    const loaded = dynamicLocationCount
      ? `${fixedLocationCount.toLocaleString()} fixed locations + ${dynamicLocationCount.toLocaleString()} dynamic encounter areas`
      : `${fixedLocationCount.toLocaleString()} locations`;
    updateStatus(loaded);
    updateHomeStatus(loaded);
    updateHomeSubtitle(`Browse locations and encounter areas in ${ROOT_FOLDER}`);
    setLandingVisible(true);
  } catch (error) {
    const errorText = `Failed to load LocationData: ${error instanceof Error ? error.message : "Unknown error"}`;
    updateStatus(errorText);
    updateHomeStatus(errorText);
    updateHomeSubtitle(`Browse Locations in ${ROOT_FOLDER}`);
    setLandingVisible(true);
  }

  // Leaflet may still be loading when this script starts.
  if (!locationMap && locationMapEl) {
    window.setTimeout(() => {
      initLocationMap();
      syncMapMarkers();
    }, 300);
  }
}

searchInput.addEventListener("input", triggerDebouncedSearch);
searchInput.addEventListener("keydown", handleSearchKeyDown);

combineBtn.addEventListener("click", () => {
  includeZInput.checked = false;
  if (combineNameInput) {
    combineNameInput.value = "";
  }
  if (combineDescriptionInput) {
    combineDescriptionInput.value = "";
  }
  if (combineIconInput) {
    combineIconInput.value = "";
  }
  if (combineIconSizeInput) {
    combineIconSizeInput.value = "";
  }
  setCombinerModal(true);
});

if (combineIconSizeInput) {
  combineIconSizeInput.addEventListener("input", () => {
    const next = filterIconSizeInputValue(combineIconSizeInput.value);
    if (next !== combineIconSizeInput.value) {
      combineIconSizeInput.value = next;
    }
  });
}

combinerCancelBtn.addEventListener("click", () => {
  setCombinerModal(false);
});

if (combinerCopyCenterBtn) {
  combinerCopyCenterBtn.addEventListener("click", () => {
    void copyFilteredCenterLocation();
  });
}

combinerCreateBtn.addEventListener("click", () => {
  downloadCombinedLocationData();
  setCombinerModal(false);
});

togglePreviewFormatBtn.addEventListener("click", () => {
  previewMode = previewMode === "wiki" ? "coords" : "wiki";
  updatePreviewModeButtonLabel();
  if (currentOpenEntry) {
    fileContentEl.textContent = getPreviewText(currentOpenEntry);
  }
});

toggleMapModeBtn.addEventListener("click", () => {
  mapMode = mapMode === "selected" ? "filtered" : "selected";
  updateMapModeButtonLabel();
  syncMapMarkers();
});

copyPreviewBtn.addEventListener("click", () => {
  void handleCopyPreview();
});

combinerModal.addEventListener("click", (event) => {
  if (event.target === combinerModal) {
    setCombinerModal(false);
  }
});

document.addEventListener("keydown", (event) => {
  if (event.key === "Escape" && !combinerModal.hidden) {
    setCombinerModal(false);
  }
});

updatePreviewModeButtonLabel();
updateMapModeButtonLabel();
updatePreviewControlsState();
init();
