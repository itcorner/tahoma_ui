const express = require('express');
const path = require('path');
const { getApiVersion, listBlindDevices, getDeviceStates, applyAction } = require('./tahomaClient');
const {
  getHistory,
  getLatestDevices,
  initializeHistoryStore,
  recordDevices,
} = require('./historyStore');

const app = express();
const port = Number(process.env.PORT || 3000);
const historyIntervalMs = 60 * 1000;

app.use(express.json());
app.use(express.static(path.join(__dirname, '..', 'public')));

function normalizeCommand(command, value) {
  const normalized = String(command || '').trim().toLowerCase();

  if (!normalized) {
    return { error: 'Missing command' };
  }

  if (['open', 'up', 'raise'].includes(normalized)) {
    return { commands: [{ name: 'open' }] };
  }

  if (['close', 'down', 'lower'].includes(normalized)) {
    return { commands: [{ name: 'close' }] };
  }

  if (['stop', 'pause'].includes(normalized)) {
    return { commands: [{ name: 'stop' }] };
  }

  if (['setposition', 'position', 'set-closure', 'set_closure'].includes(normalized)) {
    const pos = Number(value ?? 0);
    if (Number.isNaN(pos)) {
      return { error: 'Position must be a number between 0 and 100' };
    }
    const clamped = Math.max(0, Math.min(100, pos));
    return { commands: [{ name: 'setPosition', parameters: [clamped] }] };
  }

  return { error: `Unsupported command: ${command}` };
}

app.get('/health', (_req, res) => {
  res.json({ ok: true, service: 'tahoma_ui' });
});

app.get('/api/version', async (_req, res) => {
  try {
    const data = await getApiVersion();
    res.json(data);
  } catch (error) {
    res.status(500).json({
      error: 'Failed to read TaHoma API version',
      details: error.response?.data || error.message,
    });
  }
});

app.get('/api/blinds', async (_req, res) => {
  try {
    const devices = await listBlindDevices();

    const enriched = await Promise.all(
      devices.map(async (device) => {
        const states = await getDeviceStates(device.deviceURL);
        return {
          ...device,
          states,
        };
      }),
    );

    res.json(enriched);
  } catch (error) {
    res.status(500).json({
      error: 'Failed to read blind devices',
      details: error.response?.data || error.message,
    });
  }
});

app.get('/api/history', async (req, res) => {
  const range = String(req.query.range || 'today');
  if (!['hour', 'today', 'week', 'month'].includes(range)) {
    return res.status(400).json({ error: 'range must be hour, today, week, or month' });
  }

  try {
    const points = await getHistory({
      deviceUrl: req.query.deviceURL ? String(req.query.deviceURL) : null,
      range,
    });
    return res.json({ range, points });
  } catch (error) {
    return res.status(500).json({ error: 'Failed to read blind history', details: error.message });
  }
});

app.post('/api/blinds/command', async (req, res) => {
  const { deviceURL, command, value } = req.body || {};

  if (!deviceURL) {
    return res.status(400).json({ error: 'deviceURL is required' });
  }

  const resolved = normalizeCommand(command, value);
  if (resolved.error) {
    return res.status(400).json({ error: resolved.error });
  }

  try {
    const result = await applyAction({
      deviceURL,
      commands: resolved.commands,
      label: `UI ${command}`,
    });

    return res.json({ ok: true, deviceURL, command, result });
  } catch (error) {
    return res.status(500).json({
      error: 'Failed to send command to TaHoma gateway',
      details: error.response?.data || error.message,
    });
  }
});

app.use((req, res) => {
  if (req.path.startsWith('/api/')) {
    return res.status(404).json({ error: 'Route not found' });
  }
  return res.sendFile(path.join(__dirname, '..', 'public', 'index.html'));
});

async function collectHistorySample() {
  try {
    const devices = await listBlindDevices();
    const enriched = await Promise.all(
      devices.map(async (device) => ({
        ...device,
        states: await getDeviceStates(device.deviceURL),
      })),
    );
    await recordDevices(enriched);
    return enriched;
  } catch (error) {
    console.error(`History collection failed: ${error.message}`);
    return [];
  }
}

async function start() {
  await initializeHistoryStore();
  await collectHistorySample();
  setInterval(collectHistorySample, historyIntervalMs);
  app.listen(port, () => {
    console.log(`Tahoma UI listening on http://localhost:${port}`);
    console.log('Blind telemetry history collection interval: 60 seconds');
  });
}

start().catch((error) => {
  console.error(`Unable to start telemetry store: ${error.message}`);
  process.exitCode = 1;
});
