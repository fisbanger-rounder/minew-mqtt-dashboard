// ── State ───────────────────────────────────────────────────
const sensors = new Map();
let evtSource = null;
let isConnected = false;

const els = {
  status: document.getElementById('status'),
  brokerUrl: document.getElementById('brokerUrl'),
  brokerPort: document.getElementById('brokerPort'),
  brokerUsername: document.getElementById('brokerUsername'),
  brokerPassword: document.getElementById('brokerPassword'),
  connectBtn: document.getElementById('connectBtn'),
  disconnectBtn: document.getElementById('disconnectBtn'),
  newTopic: document.getElementById('newTopic'),
  addTopicBtn: document.getElementById('addTopicBtn'),
  topicTags: document.getElementById('topicTags'),
  grid: document.getElementById('sensorGrid'),
  log: document.getElementById('mqttLog'),
};

// ── Helpers ─────────────────────────────────────────────────
function nowTime(ts) {
  const d = ts ? new Date(ts) : new Date();
  return d.toTimeString().split(' ')[0];
}

// Robust JSON/text response parser to avoid "Unexpected token '<'" errors
async function parseResponse(res) {
  const ct = res.headers.get('content-type') || '';
  if (ct.includes('application/json')) {
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
  const li = document.createElement('li');
  li.innerHTML = `<span class="time">${nowTime(ts)}</span><span class="topic">${topic}</span><span class="payload">${payload.substring(0, 120)}</span>`;
  els.log.prepend(li);
  if (els.log.children.length > 100) els.log.lastElementChild.remove();
}

function loadDefaultTopics() {
  const defaults = ['/iot/esp32/+/telemetry'];
  defaults.forEach(t => addTopic(t));
}

function renderTopics() {
  els.topicTags.innerHTML = '';
  subscribedTopics.forEach(topic => {
    const tag = document.createElement('span');
    tag.className = 'tag';
    tag.innerHTML = `${topic} <button class="tag-remove" data-topic="${topic}">×</button>`;
    els.topicTags.appendChild(tag);
  });

  document.querySelectorAll('.tag-remove').forEach(btn => {
    btn.addEventListener('click', (e) => {
      removeTopic(e.target.dataset.topic);
    });
  });
}

let subscribedTopics = new Set();
let pendingTopics = null;

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
  renderTopics();
  syncTopics();
}

async function syncTopics() {
  try {
    const res = await fetch('/api/topics', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ topics: Array.from(subscribedTopics) }),
    });
    const data = await parseResponse(res);
    if (!res.ok) throw new Error(data.error || 'Failed to sync topics');
    console.log('Synced topics:', data.subscribed);
  } catch (e) {
    console.error('Failed to sync topics:', e);
  }
}

// ── Sensor Cards (dynamic metrics) ──────────────────────────
function getOrCreateCard(sensorId) {
  if (sensors.has(sensorId)) return sensors.get(sensorId);

  const card = document.createElement('div');
  card.className = 'card';
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

  const wrap = document.createElement('div');
  wrap.className = 'metric';
  wrap.innerHTML = `
    <span class="metric-label">${label}</span>
    <div>
      <span class="metric-value" id="${id}">--</span>
      <span class="metric-unit">${unit}</span>
      ${metricKey === 'battery' ? `<div class="battery-bar"><div class="battery-fill" id="bar-${sensorId}" style="width:0%"></div></div>` : ''}
    </div>
  `;
  container.appendChild(wrap);
  return document.getElementById(id);
}

function guessUnit(metricKey) {
  const lower = metricKey.toLowerCase();
  if (lower.includes('temp')) return '°C';
  if (lower.includes('hum')) return '%';
  if (lower.includes('bat')) return '%';
  if (lower.includes('pres')) return 'hPa';
  if (lower.includes('volt')) return 'V';
  if (lower.includes('rssi')) return 'dBm';
  return '';
}

function updateMetric(sensorId, metricKey, value) {
  const data = getOrCreateCard(sensorId);
  data.metrics[metricKey] = value;
  data.lastSeen = new Date();

  const unit = guessUnit(metricKey);
  const el = ensureMetricEl(sensorId, metricKey, metricKey, unit);
  const num = parseFloat(value);

  if (!Number.isNaN(num)) {
    el.textContent = Number.isInteger(num) ? num : num.toFixed(2);
  } else {
    el.textContent = value;
  }

  el.parentElement.classList.add('updating');
  setTimeout(() => el.parentElement.classList.remove('updating'), 800);

  if (metricKey.toLowerCase().includes('bat')) {
    const bar = document.getElementById(`bar-${sensorId}`);
    if (bar) {
      bar.style.width = `${Math.max(0, Math.min(100, num))}%`;
      bar.style.background =
        num > 50 ? 'var(--success)' : num > 20 ? 'var(--warning)' : 'var(--danger)';
    }
    el.classList.add('bat');
  } else if (metricKey.toLowerCase().includes('temp')) {
    el.classList.add('temp');
  } else if (metricKey.toLowerCase().includes('hum')) {
    el.classList.add('hum');
  }

  const ls = document.getElementById(`ls-${sensorId}`);
  ls.textContent = `Last seen: ${nowTime()}`;
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

  // Handle user's JSON structure: { ts, data: { mac, rssi, battery, temperature, humidity, ... } }
  const telemetry = payload.data || payload;

  Object.entries(telemetry).forEach(([key, value]) => {
    if (typeof value === 'number') {
      updateMetric(sensorId, key, value);
    } else if (typeof value === 'string' && !isNaN(parseFloat(value))) {
      updateMetric(sensorId, key, parseFloat(value));
    }
  });
}

// ── SSE Connection ──────────────────────────────────────────
function connectSSE() {
  if (evtSource) evtSource.close();

  evtSource = new EventSource('/events');

  evtSource.onopen = () => {
    isConnected = true;
  };

  evtSource.onmessage = (e) => {
    const msg = JSON.parse(e.data);
    if (msg.type === 'status') {
      const text = msg.status === 'connected'
        ? '🟢 Connected'
        : msg.status === 'error'
          ? `❌ Error: ${msg.error || ''}`
          : '🔴 Disconnected';
      els.status.textContent = text;
      isConnected = msg.status === 'connected';
      updateBrokerButtons();
    } else if (msg.type === 'message') {
      handleMessage(msg.topic, msg.message);
    }
  };

  evtSource.onerror = () => {
    isConnected = false;
    els.status.textContent = '🔴 Disconnected';
    updateBrokerButtons();
  };
}

function updateBrokerButtons() {
  els.connectBtn.disabled = !els.brokerUrl.value.trim();
  els.disconnectBtn.disabled = !isConnected;
}

async function loadBrokerConfig() {
  try {
    const res = await fetch('/api/mqtt/config');
    const config = await parseResponse(res);
    if (!res.ok) throw new Error(config.error || 'Failed to load broker config');
    els.brokerUrl.value = config.url || '';
    els.brokerPort.value = config.port || '';
    els.brokerUsername.value = config.username || '';
    els.brokerPassword.value = config.password || '';
    isConnected = config.connected;
    updateBrokerButtons();
  } catch (err) {
    console.error('Failed to load broker config:', err);
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
    const res = await fetch('/api/mqtt/connect', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(config),
    });
    const data = await parseResponse(res);
    if (!res.ok) throw new Error(data.error || 'Failed to connect');
    isConnected = data.connected;
    updateBrokerButtons();
  } catch (err) {
    console.error('Connect failed:', err);
    els.status.textContent = `❌ ${err.message}`;
  } finally {
    updateBrokerButtons();
  }
}

async function handleDisconnect() {
  els.disconnectBtn.disabled = true;
  try {
    const res = await fetch('/api/mqtt/disconnect', { method: 'POST' });
    const data = await parseResponse(res);
    if (!res.ok) throw new Error(data.error || 'Failed to disconnect');
    isConnected = data.connected === true;
    updateBrokerButtons();
  } catch (err) {
    console.error('Disconnect failed:', err);
    els.status.textContent = `❌ ${err.message}`;
  } finally {
    updateBrokerButtons();
  }
}

// ── UI Actions ──────────────────────────────────────────────
els.connectBtn.addEventListener('click', handleConnect);
els.disconnectBtn.addEventListener('click', handleDisconnect);
els.brokerUrl.addEventListener('input', updateBrokerButtons);
els.brokerPort.addEventListener('input', updateBrokerButtons);

els.addTopicBtn.addEventListener('click', () => {
  const topic = els.newTopic.value.trim();
  if (topic) {
    addTopic(topic);
    els.newTopic.value = '';
  }
});

els.newTopic.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') els.addTopicBtn.click();
});

// Init
loadBrokerConfig();
loadDefaultTopics();
connectSSE();
syncTopics();