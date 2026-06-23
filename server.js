const express = require('express');
const mqtt = require('mqtt');
const path = require('path');

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

const DEFAULT_BROKER_HOST = '192.168.68.106';
const DEFAULT_BROKER_PORT = '1885';
const HTTP_PORT = 3000;

let mqttConfig = buildInitialConfig();
let mqttClient = null;
let isDisconnecting = false;
const sseClients = new Set();
const currentTopics = new Set();

function buildInitialConfig() {
  const envBroker = process.env.BROKER || `mqtt://${DEFAULT_BROKER_HOST}:${DEFAULT_BROKER_PORT}`;
  try {
    const parsed = new URL(envBroker);
    return {
      url: `${parsed.protocol}//${parsed.hostname}`,
      port: parsed.port || DEFAULT_BROKER_PORT,
      username: process.env.MQTT_USERNAME || parsed.username || '',
      password: process.env.MQTT_PASSWORD || parsed.password || '',
    };
  } catch {
    return {
      url: `mqtt://${DEFAULT_BROKER_HOST}`,
      port: DEFAULT_BROKER_PORT,
      username: process.env.MQTT_USERNAME || '',
      password: process.env.MQTT_PASSWORD || '',
    };
  }
}

function normalizeBrokerUrl(url, port) {
  let broker = String(url || '').trim();
  if (!broker) broker = `mqtt://${DEFAULT_BROKER_HOST}`;
  if (!/^([a-z][a-z0-9+.-]*):\/\//i.test(broker)) {
    broker = `mqtt://${broker}`;
  }
  try {
    const parsed = new URL(broker);
    parsed.port = String(port || parsed.port || DEFAULT_BROKER_PORT);
    return parsed.toString();
  } catch {
    return broker;
  }
}

function broadcast(obj) {
  const data = JSON.stringify(obj);
  sseClients.forEach(res => res.write(`data: ${data}\n\n`));
}

function createMqttClient(config) {
  const connectUrl = normalizeBrokerUrl(config.url, config.port);
  const options = {
    reconnectPeriod: 5000,
    connectTimeout: 30000,
  };
  if (config.username) options.username = config.username;
  if (config.password) options.password = config.password;

  const client = mqtt.connect(connectUrl, options);

  client.on('connect', () => {
    isDisconnecting = false;
    console.log('✅ MQTT connected to', connectUrl);
    currentTopics.forEach(topic => client.subscribe(topic));
    broadcast({ type: 'status', status: 'connected' });
  });

  client.on('message', (topic, payload) => {
    const message = payload.toString();
    broadcast({ type: 'message', topic, message, time: Date.now() });
  });

  client.on('error', err => {
    console.error('❌ MQTT error:', err.message);
    broadcast({ type: 'status', status: 'error', error: err.message });
  });

  client.on('offline', () => {
    console.log('⚠️ MQTT offline');
    broadcast({ type: 'status', status: 'offline' });
  });

  client.on('close', () => {
    broadcast({ type: 'status', status: 'disconnected' });
  });

  return client;
}

function getBrokerStatus() {
  return mqttClient && mqttClient.connected ? 'connected' : 'disconnected';
}

function endMqttClient(force = true) {
  return new Promise(resolve => {
    if (!mqttClient) return resolve();
    isDisconnecting = true;
    mqttClient.end(force, () => {
      mqttClient = null;
      resolve();
    });
  });
}

async function connectToBroker(config) {
  await endMqttClient(true);
  mqttConfig = {
    url: String(config.url || mqttConfig.url).trim() || mqttConfig.url,
    port: String(config.port || mqttConfig.port).trim() || mqttConfig.port,
    username: String(config.username || mqttConfig.username || '').trim(),
    password: String(config.password || mqttConfig.password || '').trim(),
  };
  mqttClient = createMqttClient(mqttConfig);
}

mqttClient = createMqttClient(mqttConfig);

app.get('/events', (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();

  sseClients.add(res);

  const status = getBrokerStatus();
  res.write(`data: ${JSON.stringify({ type: 'status', status })}\n\n`);

  req.on('close', () => {
    sseClients.delete(res);
  });
});

app.get('/api/mqtt/config', (req, res) => {
  res.json({ ...mqttConfig, connected: getBrokerStatus() === 'connected' });
});

app.post('/api/mqtt/connect', async (req, res) => {
  try {
    await connectToBroker(req.body || {});
    res.json({ ...mqttConfig, connected: getBrokerStatus() === 'connected' });
  } catch (error) {
    console.error('Failed to connect MQTT broker:', error.message);
    res.status(500).json({ error: error.message || 'Failed to connect' });
  }
});

app.post('/api/mqtt/disconnect', async (req, res) => {
  try {
    await endMqttClient(true);
    broadcast({ type: 'status', status: 'disconnected' });
    res.json({ connected: false });
  } catch (error) {
    res.status(500).json({ error: error.message || 'Failed to disconnect' });
  }
});

app.post('/api/topics', (req, res) => {
  const { topics } = req.body;
  if (!Array.isArray(topics)) {
    return res.status(400).json({ error: 'topics must be an array' });
  }

  currentTopics.forEach(topic => {
    if (mqttClient) mqttClient.unsubscribe(topic);
  });
  currentTopics.clear();

  topics.forEach(topic => {
    if (topic && typeof topic === 'string') {
      currentTopics.add(topic);
      if (mqttClient && mqttClient.connected) mqttClient.subscribe(topic);
    }
  });

  console.log('Subscribed topics:', Array.from(currentTopics));
  res.json({ subscribed: Array.from(currentTopics) });
});

app.get('/api/topics', (req, res) => {
  res.json({ subscribed: Array.from(currentTopics) });
});

app.listen(HTTP_PORT, () => {
  console.log(`🌐 Dashboard: http://localhost:${HTTP_PORT}`);
  console.log(`📡 MQTT Broker: ${normalizeBrokerUrl(mqttConfig.url, mqttConfig.port)}`);
});
