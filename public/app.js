const statusBox = document.getElementById('status');
const deviceGrid = document.getElementById('deviceGrid');
const overviewGrid = document.getElementById('overviewGrid');
const overviewMeta = document.getElementById('overviewMeta');
const historyCharts = document.getElementById('historyCharts');
let selectedHistoryRange = 'today';
let historyEventsReady = false;
let historyChartInstances = [];

function escapeHtml(value) {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;');
}

function getState(states, names, fallback = null) {
  const state = states.find((item) => names.includes(String(item?.name || '').toLowerCase()));
  return state?.value ?? fallback;
}

function deviceSnapshot(device) {
  const states = device.states || [];
  const position = Number(getState(states, ['core:closurestate', 'closurestate', 'position', 'currentposition'], 0));
    const discreteRssi = getState(states, ['core:discreterssilevelstate'], null);
    const rssi = Number(getState(states, ['core:rssilevelstate', 'rssi', 'signalstrength'], NaN));
    const movingValue = getState(states, ['core:movingstate', 'movingstate', 'moving', 'movementstate'], false);
    const status = getState(states, ['core:statusstate', 'status', 'coverstate', 'closurestate'], 'Unknown');
  const moving = movingValue === true || /moving|inprogress|up|down/i.test(String(movingValue));
  return {
    position: Number.isFinite(position) ? Math.max(0, Math.min(100, position)) : null,
    discreteRssi: discreteRssi === null ? null : String(discreteRssi),
    rssi: Number.isFinite(rssi) ? rssi : null,
    status: moving ? 'Moving' : String(status),
    moving,
  };
}

function renderSignal(discreteRssi, rssi) {
  const strengthByState = { verybad: 1, bad: 2, normal: 3, good: 4 };
  const strength = strengthByState[discreteRssi?.toLowerCase()] || (rssi === null ? 0 : Math.max(1, Math.min(4, Math.ceil(rssi / 25))));
  const label = [discreteRssi, rssi === null ? null : `${rssi}%`].filter(Boolean).join(' · ') || 'unknown';
  return `<span class="signal" aria-label="RSSI ${label}">${[1, 2, 3, 4]
    .map((bar) => `<i class="${bar <= strength ? 'active' : ''}"></i>`)
    .join('')}</span>${label === 'unknown' ? 'RSSI n/a' : label}`;
}

function renderOverview(devices) {
  overviewMeta.textContent = `${devices.length} blind${devices.length === 1 ? '' : 's'} · live snapshot`;
  overviewGrid.innerHTML = devices.map((device) => {
    const snapshot = deviceSnapshot(device);
    const positionLabel = snapshot.position === null ? 'Position n/a' : `${Math.round(snapshot.position)}% closed`;
    const style = snapshot.position === null ? '' : ` style="--shade: ${snapshot.position / 100}; --position: ${snapshot.position}%"`;
    return `
      <article class="overview-card">
        <div class="overview-card-top">
          <h3>${escapeHtml(device.label || 'Unnamed blind')}</h3>
          <span class="state-badge${snapshot.moving ? ' moving' : ''}">${escapeHtml(snapshot.status)}</span>
        </div>
        <div class="blind-visual"${style} aria-label="${escapeHtml(positionLabel)}"></div>
        <div class="overview-card-bottom">
          <span>${positionLabel}</span>
          <span>${renderSignal(snapshot.discreteRssi, snapshot.rssi)}</span>
        </div>
      </article>`;
  }).join('');
}

function chartPoints(points, metric) {
  const sortedPoints = points
    .filter((point) => point[metric] !== null && point[metric] !== undefined)
    .sort((first, second) => first.sampled_at - second.sampled_at);
  const result = [];

  sortedPoints.forEach((point, index) => {
    if (index > 0 && point.sampled_at - sortedPoints[index - 1].sampled_at > 90) {
      result.push({ x: (sortedPoints[index - 1].sampled_at + 60) * 1000, y: null });
    }
    result.push({ x: point.sampled_at * 1000, y: Number(point[metric]) });
  });

  return result;
}

function renderMetricChart(points, metric, title, range) {
  const devices = [...new Map(points.map((point) => [point.device_url, point.label])).entries()];
  const datasets = devices.map(([deviceUrl, label], index) => ({
    label,
    data: chartPoints(points.filter((point) => point.device_url === deviceUrl), metric),
    borderColor: `hsl(${(index * 137.5) % 360} 42% 38%)`,
    backgroundColor: `hsl(${(index * 137.5) % 360} 42% 38%)`,
    borderWidth: 2,
    pointRadius: 2,
    pointHoverRadius: 6,
    spanGaps: false,
    tension: 0.15,
  }));
  const chartData = escapeHtml(JSON.stringify(datasets));
  return `<section class="chart-panel"><h3>${title}</h3><div class="chart-wrap"><canvas class="metric-chart" data-chart="${chartData}" role="img" aria-label="${title} history"></canvas>${points.length ? '' : '<p class="chart-empty">No samples for this period yet</p>'}</div></section>`;
}

async function loadHistory() {
  const data = await apiFetch(`/api/history?range=${selectedHistoryRange}`);
  const points = data.points || [];
  historyChartInstances.forEach((chart) => chart.destroy());
  historyChartInstances = [];
  historyCharts.innerHTML = [
    ['rssi_level', 'RSSI level'],
    ['closure_state', 'Closure state'],
    ['target_closure_state', 'Target closure state'],
  ].map(([metric, title]) => renderMetricChart(points, metric, title, selectedHistoryRange)).join('');

  const durations = { hour: 3600, today: 86400, week: 604800, month: 2592000 };
  const end = Math.floor(Date.now() / 1000) * 1000;
  const start = end - (durations[selectedHistoryRange] || durations.today) * 1000;
  document.querySelectorAll('.metric-chart').forEach((canvas) => {
    historyChartInstances.push(new Chart(canvas, {
      type: 'line',
      data: { datasets: JSON.parse(canvas.dataset.chart || '[]') },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        animation: false,
        normalized: true,
        scales: {
          x: {
            type: 'linear',
            min: start,
            max: end,
            grid: { color: '#d9e0d9' },
            ticks: {
              color: '#71817b',
              callback: (value) => new Date(value).toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric' }),
            },
          },
          y: {
            min: 0,
            max: 100,
            grid: { color: '#d9e0d9' },
            ticks: { color: '#71817b' },
          },
        },
        plugins: {
          legend: { display: true, labels: { color: '#71817b' } },
          tooltip: {
            mode: 'nearest',
            intersect: false,
            callbacks: {
              title: (items) => new Date(items[0].parsed.x).toLocaleString(),
              label: (item) => `${item.dataset.label}: ${item.parsed.y ?? 'No measurement'}`,
            },
          },
        },
      },
    }));
  });
}

function setupHistory() {
  if (!historyEventsReady) {
    document.querySelectorAll('[data-range]').forEach((button) => {
      button.addEventListener('click', async () => {
        selectedHistoryRange = button.dataset.range;
        document.querySelectorAll('[data-range]').forEach((item) => item.classList.toggle('active', item === button));
        await loadHistory();
      });
    });
    historyEventsReady = true;
  }
  loadHistory().catch((error) => {
    historyCharts.innerHTML = `<p class="empty">${escapeHtml(error.message)}</p>`;
  });
}

async function apiFetch(path, options = {}) {
  const response = await fetch(path, {
    headers: { 'Content-Type': 'application/json' },
    ...options,
  });

  if (!response.ok) {
    const data = await response.json().catch(() => ({}));
    throw new Error(data.error || 'Request failed');
  }

  return response.json();
}

function renderStates(states = []) {
  if (!states.length) {
    return '<li class="empty">No states reported</li>';
  }

  return states
    .map((state) => {
      const name = state?.name || 'unknown';
      const value = state?.value ?? 'n/a';
      return `<li><span>${name}</span><strong>${String(value)}</strong></li>`;
    })
    .join('');
}

function renderDevice(device) {
  const states = renderStates(device.states || []);
  return `
    <article class="device">
      <h3>${escapeHtml(device.label || 'Unnamed blind')}</h3>
      <div class="meta">${escapeHtml(device.deviceURL)}</div>
      <ul class="state-list">${states}</ul>
      <div class="controls">
        <button class="open" data-command="open" data-device-url="${device.deviceURL}">Open</button>
        <button class="stop" data-command="stop" data-device-url="${device.deviceURL}">Stop</button>
        <button class="close" data-command="close" data-device-url="${device.deviceURL}">Close</button>
      </div>
    </article>
  `;
}

async function loadDevices() {
  try {
    statusBox.textContent = 'Loading devices…';
    const devices = await apiFetch('/api/blinds');

    if (!devices.length) {
      deviceGrid.innerHTML = '<div class="empty">No roller blind devices were found.</div>';
      statusBox.textContent = 'No eligible devices detected';
      return;
    }

    deviceGrid.innerHTML = devices.map(renderDevice).join('');
    renderOverview(devices);
    setupHistory();
    statusBox.textContent = `${devices.length} device(s) found`;

    document.querySelectorAll('[data-command]').forEach((button) => {
      button.addEventListener('click', async () => {
        const { command, deviceUrl } = button.dataset;
        button.disabled = true;
        button.textContent = 'Sending…';

        try {
          await apiFetch('/api/blinds/command', {
            method: 'POST',
            body: JSON.stringify({ deviceURL: deviceUrl, command }),
          });
          statusBox.textContent = `Command sent: ${command}`;
          await loadDevices();
        } catch (error) {
          statusBox.textContent = error.message;
        } finally {
          button.disabled = false;
        }
      });
    });
  } catch (error) {
    statusBox.textContent = error.message;
    deviceGrid.innerHTML = '<div class="empty">Unable to load devices from the TaHoma gateway.</div>';
  }
}

loadDevices();
setInterval(loadDevices, 60 * 1000);
