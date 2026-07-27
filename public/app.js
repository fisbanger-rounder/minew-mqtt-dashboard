// ── State ───────────────────────────────────────────────────
const sensors = new Map();
let evtSource = null;
let isConnected = false;

// ── Graph State ─────────────────────────────────────────────
const GRAPH_WINDOW_MS = 10 * 60 * 1000; // 10 minutes
const sensorHistory = new Map(); // sensorId -> { metricKey -> [{t, v}] }
const sensorCharts = new Map(); // sensorId -> Chart instance

const CHART_COLORS = [
  "#38bdf8",
  "#a78bfa",
  "#f87171",
  "#34d399",
  "#fbbf24",
  "#fb923c",
  "#e879f9",
  "#22d3ee",
  "#4ade80",
  "#f472b6",
];

const els = {
  status: document.getElementById("status"),
  brokerUrl: document.getElementById("brokerUrl"),
  brokerPort: document.getElementById("brokerPort"),
  brokerUsername: document.getElementById("brokerUsername"),
  brokerPassword: document.getElementById("brokerPassword"),
  connectBtn: document.getElementById("connectBtn"),
  disconnectBtn: document.getElementById("disconnectBtn"),
  brokerSection: document.getElementById("brokerSection"),
  topicsSection: document.getElementById("topicsSection"),
  logSection: document.getElementById("logSection"),
  toggleViewBtn: document.getElementById("toggleViewBtn"),
  newTopic: document.getElementById("newTopic"),
  addTopicBtn: document.getElementById("addTopicBtn"),
  topicTags: document.getElementById("topicTags"),
  grid: document.getElementById("sensorGrid"),
  log: document.getElementById("mqttLog"),
  graphsGrid: document.getElementById("graphsGrid"),
  graphsSection: document.getElementById("graphsSection"),
};

// ── Helpers ─────────────────────────────────────────────────
function nowTime(ts) {
  const d = ts ? new Date(ts) : new Date();
  return d.toTimeString().split(" ")[0];
}

// Robust JSON/text response parser to avoid "Unexpected token '<'" errors
async function parseResponse(res) {
  const ct = res.headers.get("content-type") || "";
  if (ct.includes("application/json")) {
    return await res.json();
  }
  const text = await res.text();
  try {
    return JSON.parse(text);
  } catch {
    return { error: text, _raw: text };
  }
}

function log(topic, payload, ts) {
  const li = document.createElement("li");
  li.innerHTML = `<span class="time">${nowTime(ts)}</span><span class="topic">${topic}</span><span class="payload">${payload.substring(0, 120)}</span>`;
  els.log.prepend(li);
  if (els.log.children.length > 100) els.log.lastElementChild.remove();
}

async function loadPersistedTopics() {
  try {
    const res = await fetch("/api/topics");
    const data = await parseResponse(res);
    if (!res.ok) throw new Error(data.error || "Failed to load topics");
    if (Array.isArray(data.subscribed)) {
      data.subscribed.forEach((topic) => addTopic(topic));
    }
  } catch (err) {
    console.error("Failed to load persisted topics:", err);
  }
}

function renderTopics() {
  els.topicTags.innerHTML = "";
  subscribedTopics.forEach((topic) => {
    const tag = document.createElement("span");
    tag.className = "tag";
    tag.innerHTML = `${topic} <button class="tag-remove" data-topic="${topic}">×</button>`;
    els.topicTags.appendChild(tag);
  });

  document.querySelectorAll(".tag-remove").forEach((btn) => {
    btn.addEventListener("click", (e) => {
      removeTopic(e.target.dataset.topic);
    });
  });
}

let subscribedTopics = new Set();
let pendingTopics = null;
let isSensorOnlyView = false;

function addTopic(topic) {
  topic = topic.trim();
  if (!topic || subscribedTopics.has(topic)) return;
  subscribedTopics.add(topic);
  renderTopics();
  syncTopics();
}

function removeTopic(topic) {
  if (!subscribedTopics.has(topic)) return;
  subscribedTopics.delete(topic);
  clearAllSensors();
  renderTopics();
  syncTopics();
  updateCompactView();
}

function clearAllSensors() {
  // Remove sensor cards
  sensors.forEach((data) => data.el.remove());
  sensors.clear();

  // Remove graph cards and destroy chart instances
  sensorCharts.forEach((chart) => chart.destroy());
  sensorCharts.clear();
  sensorHistory.clear();
  els.graphsGrid.innerHTML = "";
}

async function syncTopics() {
  try {
    const res = await fetch("/api/topics", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ topics: Array.from(subscribedTopics) }),
    });
    const data = await parseResponse(res);
    if (!res.ok) throw new Error(data.error || "Failed to sync topics");
    console.log("Synced topics:", data.subscribed);
  } catch (e) {
    console.error("Failed to sync topics:", e);
  }
}

// ── Sensor Cards (dynamic metrics) ──────────────────────────
function getOrCreateCard(sensorId) {
  if (sensors.has(sensorId)) return sensors.get(sensorId);

  const card = document.createElement("div");
  card.className = "card";
  card.innerHTML = `
    <div class="card-header">
      <h3>Sensor</h3>
      <span class="sensor-id">${sensorId}</span>
    </div>
    <div class="metrics" id="metrics-${sensorId}"></div>
    <div class="last-seen" id="ls-${sensorId}">Never</div>
  `;
  els.grid.appendChild(card);

  const data = { metrics: {}, lastSeen: null, el: card };
  sensors.set(sensorId, data);
  return data;
}

function ensureMetricEl(sensorId, metricKey, label, unit) {
  const container = document.getElementById(`metrics-${sensorId}`);
  const id = `m-${sensorId}-${metricKey}`;
  if (document.getElementById(id)) return document.getElementById(id);

  const wrap = document.createElement("div");
  wrap.className = "metric";
  wrap.innerHTML = `
    <span class="metric-label">${label}</span>
    <div>
      <span class="metric-value" id="${id}">--</span>
      <span class="metric-unit">${unit}</span>
      ${metricKey === "battery" ? `<div class="battery-bar"><div class="battery-fill" id="bar-${sensorId}" style="width:0%"></div></div>` : ""}
    </div>
  `;
  container.appendChild(wrap);
  return document.getElementById(id);
}

function guessUnit(metricKey) {
  const lower = metricKey.toLowerCase();
  if (lower.includes("temp")) return "°C";
  if (lower.includes("hum")) return "%";
  if (lower.includes("bat")) return "%";
  if (lower.includes("pres")) return "hPa";
  if (lower.includes("volt")) return "V";
  if (lower.includes("rssi")) return "dBm";
  if (lower.includes("alt")) return "m";
  return "";
}

function updateMetric(sensorId, metricKey, value) {
  const data = getOrCreateCard(sensorId);
  data.metrics[metricKey] = value;
  data.lastSeen = new Date();

  const unit = guessUnit(metricKey);
  const el = ensureMetricEl(sensorId, metricKey, metricKey, unit);
  const num = parseFloat(value);
  const isNumeric = !Number.isNaN(num);

  if (isNumeric) {
    el.textContent = Number.isInteger(num) ? num : num.toFixed(2);
  } else {
    el.textContent = value;
  }

  el.parentElement.classList.add("updating");
  setTimeout(() => el.parentElement.classList.remove("updating"), 800);

  const lowerKey = metricKey.toLowerCase();
  if (lowerKey.includes("bat")) {
    const bar = document.getElementById(`bar-${sensorId}`);
    if (bar && isNumeric) {
      bar.style.width = `${Math.max(0, Math.min(100, num))}%`;
      bar.style.background =
        num > 50
          ? "var(--success)"
          : num > 20
            ? "var(--warning)"
            : "var(--danger)";
    }
    el.classList.add("bat");
  } else if (lowerKey.includes("temp")) {
    el.classList.add("temp");
  } else if (lowerKey.includes("hum")) {
    el.classList.add("hum");
  } else if (lowerKey.includes("prox")) {
    el.classList.add("prox");
  } else if (lowerKey.includes("pres")) {
    el.classList.add("pres");
    if (isNumeric) {
      // Example ranges in hPa — adjust to your needs
      el.style.color =
        num < 980
          ? "var(--danger)"
          : num < 1000
            ? "var(--warning)"
            : num > 1025
              ? "var(--accent)"
              : "var(--success)";
    }
  } else if (lowerKey.includes("alt")) {
    el.classList.add("alt");
    if (isNumeric) {
      // Example ranges in meters — adjust to your needs
      el.style.color =
        num < 100
          ? "var(--success)"
          : num < 500
            ? "var(--warning)"
            : "var(--danger)";
    }
  }

  const ls = document.getElementById(`ls-${sensorId}`);
  ls.textContent = `Last seen: ${nowTime()}`;

  // ── Push to graph history ──
  if (isNumeric) {
    pushGraphData(sensorId, metricKey, num);
  }
}

function updateProximity(sensorId, proximity) {
  const container = document.getElementById(`metrics-${sensorId}`);
  if (!container) return;

  const id = `prox-${sensorId}`;
  let badge = document.getElementById(id);
  if (!badge) {
    const wrap = document.createElement('div');
    wrap.className = 'metric';
    wrap.innerHTML = `
      <span class="metric-label">proximity</span>
      <div>
        <span class="proximity-badge" id="${id}"></span>
      </div>
    `;
    container.appendChild(wrap);
    badge = document.getElementById(id);
  }

  badge.textContent = proximity;
  badge.className = 'proximity-badge';
  if (proximity === 'Near') {
    badge.classList.add('prox-near');
  } else if (proximity === 'Around') {
    badge.classList.add('prox-around');
  } else {
    badge.classList.add('prox-far');
  }

  badge.parentElement.classList.add('updating');
  setTimeout(() => badge.parentElement.classList.remove('updating'), 800);
}

// ── Graph Functions ─────────────────────────────────────────
function pushGraphData(sensorId, metricKey, value) {
  if (!sensorHistory.has(sensorId)) {
    sensorHistory.set(sensorId, new Map());
  }
  const metricsMap = sensorHistory.get(sensorId);
  if (!metricsMap.has(metricKey)) {
    metricsMap.set(metricKey, []);
  }
  const arr = metricsMap.get(metricKey);
  const now = Date.now();
  arr.push({ t: now, v: value });

  // Trim data older than 10 minutes
  const cutoff = now - GRAPH_WINDOW_MS;
  while (arr.length > 0 && arr[0].t < cutoff) {
    arr.shift();
  }

  updateGraph(sensorId);
}

function getOrCreateGraphCard(sensorId) {
  const canvasId = `chart-${sensorId}`;
  let canvas = document.getElementById(canvasId);
  if (canvas) return canvas;

  const card = document.createElement("div");
  card.className = "graph-card";
  card.id = `graph-card-${sensorId}`;
  card.innerHTML = `
    <div class="graph-card-header">
      <h3>Sensor</h3>
      <span class="graph-sensor-id">${sensorId}</span>
    </div>
    <canvas id="${canvasId}"></canvas>
  `;
  els.graphsGrid.appendChild(card);
  return document.getElementById(canvasId);
}

function updateGraph(sensorId) {
  const metricsMap = sensorHistory.get(sensorId);
  if (!metricsMap || metricsMap.size === 0) return;

  const canvas = getOrCreateGraphCard(sensorId);

  // Build datasets
  const datasets = [];
  let colorIdx = 0;
  for (const [metricKey, points] of metricsMap.entries()) {
    const color = CHART_COLORS[colorIdx % CHART_COLORS.length];
    datasets.push({
      label: `${metricKey} (${guessUnit(metricKey) || "-"})`,
      data: points.map((p) => ({ x: p.t, y: p.v })),
      borderColor: color,
      backgroundColor: color + "22",
      borderWidth: 2,
      pointRadius: 0,
      pointHoverRadius: 4,
      tension: 0.3,
      fill: true,
    });
    colorIdx++;
  }

  const now = Date.now();
  const xMin = now - GRAPH_WINDOW_MS;
  const xMax = now;

  if (sensorCharts.has(sensorId)) {
    // Update existing chart
    const chart = sensorCharts.get(sensorId);
    chart.data.datasets = datasets;
    chart.options.scales.x.min = xMin;
    chart.options.scales.x.max = xMax;
    chart.update("none"); // skip animations for perf
  } else {
    // Create new chart
    const ctx = canvas.getContext("2d");
    const chart = new Chart(ctx, {
      type: "line",
      data: { datasets },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        animation: { duration: 0 },
        interaction: {
          mode: "nearest",
          intersect: true,
        },
        plugins: {
          legend: {
            position: "top",
            labels: {
              color: "#94a3b8",
              font: { size: 11 },
              boxWidth: 14,
              padding: 10,
            },
          },
          tooltip: {
            backgroundColor: "#1e293bdd",
            titleColor: "#f1f5f9",
            bodyColor: "#94a3b8",
            borderColor: "#334155",
            borderWidth: 1,
            callbacks: {
              title(items) {
                if (!items.length) return "";
                return new Date(items[0].parsed.x).toLocaleTimeString();
              },
            },
          },
        },
        scales: {
          x: {
            type: "linear",
            min: xMin,
            max: xMax,
            ticks: {
              color: "#94a3b8",
              font: { size: 10 },
              maxTicksLimit: 6,
              callback(val) {
                return new Date(val).toLocaleTimeString([], {
                  hour: "2-digit",
                  minute: "2-digit",
                });
              },
            },
            grid: {
              color: "#33415544",
            },
          },
          y: {
            ticks: {
              color: "#94a3b8",
              font: { size: 10 },
            },
            grid: {
              color: "#33415544",
            },
          },
        },
      },
    });
    sensorCharts.set(sensorId, chart);
  }
}

function extractSensorId(topic) {
  const m = topic.match(/\/([^/]+)\/telemetry$/);
  return m ? m[1] : null;
}

function handleMessage(topic, rawPayload) {
  log(topic, rawPayload);

  const sensorId = extractSensorId(topic);
  if (!sensorId) return;

  let payload;
  try {
    payload = JSON.parse(rawPayload);
  } catch {
    return;
  }

  // Handle user's JSON structure: { ts, data: { mac, rssi, battery, temperature, humidity, proximity, ... } }
  const telemetry = payload.data || payload;

  Object.entries(telemetry).forEach(([key, value]) => {
    if (key.toLowerCase() === "mac") return; // MAC is already shown as the sensor id
    if (value === null || value === undefined) return;
    if (typeof value === "object") return; // skip nested objects/arrays
    updateMetric(sensorId, key, value);
  });

  // Derive proximity from RSSI
  const rssiVal = parseFloat(telemetry.rssi ?? telemetry.RSSI);
  if (!Number.isNaN(rssiVal)) {
    let proximity;
    if (rssiVal > -20) {
      proximity = 'Near';
    } else if (rssiVal >= -40) {
      proximity = 'Around';
    } else {
      proximity = 'Far';
    }
    updateProximity(sensorId, proximity);
  }
}

// ── SSE Connection ──────────────────────────────────────────
function connectSSE() {
  if (evtSource) evtSource.close();

  evtSource = new EventSource("/events");

  evtSource.onopen = () => {
    isConnected = true;
  };

  evtSource.onmessage = (e) => {
    const msg = JSON.parse(e.data);
    if (msg.type === "status") {
      const text =
        msg.status === "connected"
          ? "🟢 Connected"
          : msg.status === "error"
            ? `❌ Error: ${msg.error || ""}`
            : "🔴 Disconnected";
      els.status.textContent = text;
      isConnected = msg.status === "connected";
      updateBrokerButtons();
      updateCompactView();
    } else if (msg.type === "message") {
      handleMessage(msg.topic, msg.message);
    }
  };

  evtSource.onerror = () => {
    isConnected = false;
    els.status.textContent = "🔴 Disconnected";
    updateBrokerButtons();
  };
}

function updateBrokerButtons() {
  els.connectBtn.disabled = !els.brokerUrl.value.trim();
  els.disconnectBtn.disabled = !isConnected;
}

function isConfigComplete() {
  const brokerReady = els.brokerUrl.value.trim() && els.brokerPort.value.trim();
  const topicsReady = subscribedTopics.size > 0;
  return brokerReady && topicsReady && isConnected;
}

function updateCompactView() {
  const complete = isConfigComplete();
  els.toggleViewBtn.hidden = !complete;

  if (!complete) {
    isSensorOnlyView = false;
  }

  els.brokerSection.hidden = isSensorOnlyView;
  els.topicsSection.hidden = isSensorOnlyView;
  els.logSection.hidden = isSensorOnlyView;
  // Keep graphs visible in sensor-only view
  els.toggleViewBtn.textContent = isSensorOnlyView
    ? "Show full dashboard"
    : "Show sensor-only view";
}

function toggleViewMode() {
  isSensorOnlyView = !isSensorOnlyView;
  updateCompactView();
}

async function loadBrokerConfig() {
  try {
    const res = await fetch("/api/mqtt/config");
    const config = await parseResponse(res);
    if (!res.ok)
      throw new Error(config.error || "Failed to load broker config");
    els.brokerUrl.value = config.url || "";
    els.brokerPort.value = config.port || "";
    els.brokerUsername.value = config.username || "";
    els.brokerPassword.value = config.password || "";
    isConnected = config.connected;
    updateBrokerButtons();
    updateCompactView();
  } catch (err) {
    console.error("Failed to load broker config:", err);
  }
}

async function handleConnect() {
  const config = {
    url: els.brokerUrl.value.trim(),
    port: els.brokerPort.value.trim(),
    username: els.brokerUsername.value.trim(),
    password: els.brokerPassword.value,
  };

  els.connectBtn.disabled = true;
  try {
    const res = await fetch("/api/mqtt/connect", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(config),
    });
    const data = await parseResponse(res);
    if (!res.ok) throw new Error(data.error || "Failed to connect");
    isConnected = data.connected;
    updateBrokerButtons();
  } catch (err) {
    console.error("Connect failed:", err);
    const msg = err?.message || "Incorrect broker settings";
    els.status.textContent = `❌ ${msg}`;
  } finally {
    updateBrokerButtons();
    updateCompactView();
  }
}

async function handleDisconnect() {
  els.disconnectBtn.disabled = true;
  try {
    const res = await fetch("/api/mqtt/disconnect", { method: "POST" });
    const data = await parseResponse(res);
    if (!res.ok) throw new Error(data.error || "Failed to disconnect");
    isConnected = data.connected === true;
    updateBrokerButtons();
  } catch (err) {
    console.error("Disconnect failed:", err);
    els.status.textContent = `❌ ${err.message}`;
  } finally {
    updateBrokerButtons();
    updateCompactView();
  }
}

// ── UI Actions ──────────────────────────────────────────────
els.connectBtn.addEventListener("click", handleConnect);
els.disconnectBtn.addEventListener("click", handleDisconnect);
els.brokerUrl.addEventListener("input", () => {
  updateBrokerButtons();
  updateCompactView();
});
els.brokerPort.addEventListener("input", () => {
  updateBrokerButtons();
  updateCompactView();
});
els.brokerUsername.addEventListener("input", updateCompactView);
els.brokerPassword.addEventListener("input", updateCompactView);
els.toggleViewBtn.addEventListener("click", toggleViewMode);

els.addTopicBtn.addEventListener("click", () => {
  const topic = els.newTopic.value.trim();
  if (topic) {
    addTopic(topic);
    els.newTopic.value = "";
    updateCompactView();
  }
});

els.newTopic.addEventListener("keydown", (e) => {
  if (e.key === "Enter") els.addTopicBtn.click();
});

// Init
async function init() {
  loadBrokerConfig();
  connectSSE();
  await loadPersistedTopics();
}
init();
