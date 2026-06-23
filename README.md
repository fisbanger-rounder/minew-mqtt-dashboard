# MQTT Sensor Dashboard

A lightweight MQTT sensor dashboard built with Node.js, Express, and browser SSE updates. The app connects to an MQTT broker, subscribes to topics, and renders live sensor data and logs in the browser.

## Features

- Connect / disconnect to any MQTT broker
- Subscribe to custom MQTT topics
- Live sensor dashboard cards for telemetry data
- MQTT message log with recent messages
- Uses Server-Sent Events (SSE) for real-time updates
- Built-in broker configuration with environment fallback

## Project Structure

- `server.js` - Express server and MQTT client integration
- `package.json` - project metadata and dependencies
- `public/index.html` - dashboard UI
- `public/app.js` - client-side interaction, SSE handling, and dynamic sensor rendering
- `public/style.css` - dashboard styling

## Requirements

- Node.js 16+ or compatible
- MQTT broker accessible from the machine

## Install

```bash
npm install
```

## Run

```bash
npm start
```

Then open the dashboard at:

```text
http://localhost:3000
```

## MQTT Broker Configuration

The dashboard uses an MQTT broker URL and port. Default values are loaded from the environment or fallback to:

- `BROKER` environment variable, e.g. `mqtt://192.168.68.106:1885`
- `MQTT_USERNAME`
- `MQTT_PASSWORD`

Default hardcoded broker values in `server.js`:

- host: `192.168.68.106`
- port: `1885`

### Example environment run

```bash
BROKER=mqtt://broker.example.com:1883 MQTT_USERNAME=user MQTT_PASSWORD=pass npm start
```

## Usage

1. Open the dashboard.
2. Enter the broker URL, port, and optional credentials.
3. Click `Connect`.
4. Add MQTT topics to subscribe to, for example `/iot/esp32/+/telemetry`.
5. Watch live telemetry values appear in sensor cards and the MQTT log.

## API Endpoints

The server exposes a small API used by the dashboard:

- `GET /events` - SSE event stream for status and message updates
- `GET /api/mqtt/config` - current MQTT broker configuration and connection state
- `POST /api/mqtt/connect` - connect to broker with posted config
- `POST /api/mqtt/disconnect` - disconnect from broker
- `POST /api/topics` - set subscribed topics
- `GET /api/topics` - retrieve current subscribed topics

## Notes

- The client automatically syncs topics and renders new sensor cards based on topic payloads.
- Sensor metrics are derived from JSON payload keys like temperature, humidity, battery, RSSI, etc.
- The UI uses SSE to reflect connection state and incoming MQTT messages in real time.

## License

This project is provided as-is for demo and prototyping purposes.
