const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');
const { promisify } = require('util');

const execFileAsync = promisify(execFile);
const databaseDirectory = path.join(__dirname, '..', 'data');
const databasePath = path.join(databaseDirectory, 'tahoma.sqlite');
const sqliteBinary = process.env.SQLITE3_BIN || 'sqlite3';

function quote(value) {
  if (value === null || value === undefined || value === '') {
    return 'NULL';
  }
  if (typeof value === 'number' && Number.isFinite(value)) {
    return String(value);
  }
  return `'${String(value).replaceAll("'", "''")}'`;
}

async function runSql(sql, json = false) {
  const args = [databasePath];
  if (json) {
    args.push('-json');
  }
  args.push(sql);
  const { stdout } = await execFileAsync(sqliteBinary, args, { maxBuffer: 10 * 1024 * 1024 });
  return json ? JSON.parse(stdout || '[]') : stdout;
}

function valueFor(states, name) {
  const state = states.find((item) => String(item?.name || '').toLowerCase() === name);
  return state?.value ?? null;
}

function numberValue(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function normalizeDevice(device, sampledAt) {
  const states = device.states || [];
  return {
    deviceUrl: device.deviceURL,
    label: device.label || device.deviceURL,
    sampledAt,
    rssiLevel: numberValue(valueFor(states, 'core:rssilevelstate')),
    discreteRssiLevel: valueFor(states, 'core:discreterssilevelstate'),
    status: valueFor(states, 'core:statusstate'),
    slateOrientation: numberValue(valueFor(states, 'core:slateorientationstate')),
    closureState: numberValue(valueFor(states, 'core:closurestate')),
    openClosedState: valueFor(states, 'core:openclosedstate'),
    targetClosureState: numberValue(valueFor(states, 'core:targetclosurestate')),
    movingState: valueFor(states, 'core:movingstate') === true ? 1 : 0,
  };
}

async function initializeHistoryStore() {
  fs.mkdirSync(databaseDirectory, { recursive: true });
  await runSql(`
    PRAGMA journal_mode = WAL;
    CREATE TABLE IF NOT EXISTS blind_samples (
      id INTEGER PRIMARY KEY,
      device_url TEXT NOT NULL,
      label TEXT NOT NULL,
      sampled_at INTEGER NOT NULL,
      rssi_level REAL,
      discrete_rssi_level TEXT,
      status TEXT,
      slate_orientation REAL,
      closure_state REAL,
      open_closed_state TEXT,
      target_closure_state REAL,
      moving_state INTEGER NOT NULL DEFAULT 0,
      UNIQUE(device_url, sampled_at)
    );
    CREATE INDEX IF NOT EXISTS blind_samples_device_time
      ON blind_samples(device_url, sampled_at);
  `);
}

async function recordDevices(devices, sampledAt = Math.floor(Date.now() / 1000)) {
  const samples = devices.map((device) => normalizeDevice(device, sampledAt));
  if (!samples.length) {
    return 0;
  }

  const rows = samples.map((sample) => `(
    ${quote(sample.deviceUrl)}, ${quote(sample.label)}, ${sample.sampledAt},
    ${quote(sample.rssiLevel)}, ${quote(sample.discreteRssiLevel)}, ${quote(sample.status)},
    ${quote(sample.slateOrientation)}, ${quote(sample.closureState)}, ${quote(sample.openClosedState)},
    ${quote(sample.targetClosureState)}, ${sample.movingState}
  )`).join(',');

  await runSql(`
    INSERT OR REPLACE INTO blind_samples (
      device_url, label, sampled_at, rssi_level, discrete_rssi_level, status,
      slate_orientation, closure_state, open_closed_state, target_closure_state, moving_state
    ) VALUES ${rows};
  `);
  return samples.length;
}

async function getLatestDevices() {
  return runSql(`
    SELECT * FROM blind_samples
    WHERE id IN (
      SELECT MAX(id) FROM blind_samples GROUP BY device_url
    )
    ORDER BY label;
  `, true);
}

async function getHistory({ deviceUrl, range = 'today' }) {
  const durations = { hour: 3600, today: 86400, week: 604800, month: 2592000 };
  const since = Math.floor(Date.now() / 1000) - (durations[range] || durations.today);
  const deviceFilter = deviceUrl ? ` AND device_url = ${quote(deviceUrl)}` : '';
  return runSql(`
    SELECT device_url, label, sampled_at, rssi_level, closure_state, target_closure_state
    FROM blind_samples
    WHERE sampled_at >= ${since}${deviceFilter}
    ORDER BY sampled_at ASC, label ASC;
  `, true);
}

module.exports = {
  getHistory,
  getLatestDevices,
  initializeHistoryStore,
  recordDevices,
};