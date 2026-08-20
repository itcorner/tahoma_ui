const axios = require('axios');
const https = require('https');
require('dotenv').config();

const baseURL = process.env.TAHOMA_BASE_URL || 'https://gateway-2001-0001-1891.local:8443/enduser-mobile-web/1/enduserAPI';
const bearerToken = process.env.TAHOMA_BEARER_TOKEN || '';

const api = axios.create({
  baseURL,
  timeout: 15000,
  httpsAgent: new https.Agent({
    rejectUnauthorized: false,
  }),
  headers: {
    'Content-Type': 'application/json',
  },
});

if (bearerToken) {
  api.defaults.headers.common.Authorization = `Bearer ${bearerToken}`;
}

async function getApiVersion() {
  const response = await api.get('/apiVersion');
  return response.data;
}

async function listDevices() {
  const response = await api.get('/setup/devices');
  return Array.isArray(response.data) ? response.data : [];
}

async function getDeviceStates(deviceURL) {
  const encoded = encodeURIComponent(deviceURL);
  const response = await api.get(`/setup/devices/${encoded}/states`);
  return Array.isArray(response.data) ? response.data : [];
}

async function applyAction({ deviceURL, commands, label = 'TaHoma UI command' }) {
  const payload = {
    label,
    actions: [
      {
        deviceURL,
        commands,
      },
    ],
  };

  const response = await api.post('/exec/apply', payload);
  return response.data;
}

function isBlindLike(device) {
  const haystack = [
    device?.label,
    device?.type,
    device?.controllableName,
    device?.definition?.widgetName,
    device?.definition?.type,
  ]
    .filter(Boolean)
    .join(' ')
    .toLowerCase();

  return /blind|shutter|roller|awning|screen|cover/.test(haystack);
}

async function listBlindDevices() {
  const devices = await listDevices();
  return devices.filter((device) => isBlindLike(device));
}

module.exports = {
  getApiVersion,
  listDevices,
  getDeviceStates,
  listBlindDevices,
  applyAction,
  api,
};
