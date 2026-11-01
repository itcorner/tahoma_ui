const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const { randomUUID } = require('node:crypto');
const { mkdtempSync, writeFileSync, rmSync, rmdirSync } = require('node:fs');
const { tmpdir } = require('node:os');
const path = require('node:path');
const test = require('node:test');

const image = 'tahoma-ui:db-startup-check';
const createDatabase = 'sqlite3 /app/data/tahoma.sqlite "CREATE TABLE samples (id INTEGER);"';
const verifyApplicationUser = `sh -c 'test "$(id -un)" = node && sqlite3 /app/data/tahoma.sqlite "INSERT INTO samples VALUES (1);"'`;

function runContainer(script, mount = ['--tmpfs', '/app/data'], environment = []) {
  const result = spawnSync('docker', [
    'run', '--rm', ...mount, ...environment.flatMap(value => ['--env', value]), '--entrypoint', 'sh',
    image, '-ec', script,
  ], { encoding: 'utf8', timeout: 30000 });
  assert.ifError(result.error);
  return { status: result.status, output: result.stdout + result.stderr };
}

for (const composeFile of ['docker-compose.yml', 'docker-compose-traefik.yml']) {
  test(`${composeFile} keeps application and routing ports consistent`, () => {
    const directory = mkdtempSync(path.join(tmpdir(), 'tahoma-port-test-'));
    const envFile = path.join(directory, '.env');
    try {
      for (const [filePort, shellPort, expected] of [
        ['', undefined, 3000],
        ['4000', undefined, 4000],
        ['4000', '5000', 5000],
      ]) {
        writeFileSync(envFile, `PORT=${filePort}\nTAHOMA_UI_HOSTNAME=tahoma.example.com\n`);
        const environment = { ...process.env };
        delete environment.PORT;
        if (shellPort !== undefined) {
          environment.PORT = shellPort;
        }
        const result = spawnSync('docker', [
          'compose', '--env-file', envFile, '-f', composeFile,
          'config', '--no-env-resolution', '--format', 'json',
        ], { encoding: 'utf8', env: environment, timeout: 30000 });
        assert.ifError(result.error);
        assert.equal(result.status, 0, result.stderr);
        const service = JSON.parse(result.stdout).services['tahoma-ui'];
        assert.equal(service.environment.PORT, String(expected));
        if (composeFile === 'docker-compose.yml') {
          assert.equal(service.ports[0].target, expected);
          assert.equal(service.ports[0].published, String(expected));
        } else {
          assert.equal(service.labels['traefik.http.services.tahoma-ui-srv.loadbalancer.server.port'], String(expected));
        }
      }
    } finally {
      rmSync(envFile, { force: true });
      rmdirSync(directory);
    }
  });
}

for (const port of [3000, 4000]) {
  test(`server and image health check work on port ${port}`, () => {
    const inspection = spawnSync('docker', [
      'image', 'inspect', '--format', '{{json .Config.Healthcheck.Test}}', image,
    ], { encoding: 'utf8', timeout: 30000 });
    assert.ifError(inspection.error);
    assert.equal(inspection.status, 0, inspection.stderr);
    const healthcheck = JSON.parse(inspection.stdout);
    assert.equal(healthcheck[0], 'CMD-SHELL');
    const result = runContainer(`
      tahoma-entrypoint node src/server.js &
      server_pid=$!
      trap 'kill "$server_pid"' EXIT
      node -e '
        async function waitForServer() {
          for (let attempt = 0; attempt < 50; attempt++) {
            try {
              const response = await fetch("http://127.0.0.1:${port}/health");
              if (!response.ok) throw new Error("Unhealthy server");
              return;
            } catch (error) {
              if (attempt === 49) throw error;
              await new Promise(resolve => setTimeout(resolve, 100));
            }
          }
        }
        waitForServer().catch(error => { console.error(error); process.exit(1); });
      '
      ${healthcheck[1]}
    `, undefined, [
      ...(port === 3000 ? [] : [`PORT=${port}`]),
      'TAHOMA_BASE_URL=http://127.0.0.1:1',
    ]);
    assert.equal(result.status, 0, result.output);
    assert.match(result.output, new RegExp(`listening on http://localhost:${port}`));
  });
}

test('missing database is created as node and the telemetry schema is initialized', () => {
  const result = runContainer(`
    tahoma-entrypoint node -e 'require("./src/historyStore").initializeHistoryStore().catch(error => { console.error(error); process.exit(1); })'
    test -f /app/data/tahoma.sqlite
    test "$(stat -c %U /app/data/tahoma.sqlite)" = node
    test "$(sqlite3 /app/data/tahoma.sqlite "SELECT name FROM sqlite_master WHERE name = 'blind_samples';")" = blind_samples
    sqlite3 /app/data/tahoma.sqlite "INSERT INTO blind_samples (device_url, label, sampled_at) VALUES ('test', 'test', 1);"
    tahoma-entrypoint true
    test "$(sqlite3 /app/data/tahoma.sqlite 'SELECT COUNT(*) FROM blind_samples;')" = 1
  `);
  assert.equal(result.status, 0, result.output);
  assert.match(result.output, /No database found; creating/);
});

test('custom IDs create the database and run the application with those IDs', () => {
  const result = runContainer(`
    tahoma-entrypoint sh -c 'test "$(id -u)" = 12345 && test "$(id -g)" = 23456'
    test "$(stat -c %u:%g /app/data/tahoma.sqlite)" = 12345:23456
    test "$(stat -c %u:%g /app/data)" = 12345:23456
  `, undefined, ['PUID=12345', 'PGID=23456']);
  assert.equal(result.status, 0, result.output);
});

test('custom IDs repair existing database and sidecar ownership without losing data', () => {
  const result = runContainer(`
    ${createDatabase}
    sqlite3 /app/data/tahoma.sqlite "INSERT INTO samples VALUES (42);"
    touch /app/data/tahoma.sqlite-wal /app/data/tahoma.sqlite-shm /app/data/tahoma.sqlite-journal
    chmod 400 /app/data/tahoma.sqlite*
    chmod 500 /app/data
    tahoma-entrypoint sh -c '
      test "$(id -u):$(id -g)" = 12345:23456
      for file in /app/data/tahoma.sqlite*; do
        test "$(stat -c %u:%g "$file")" = 12345:23456
      done
      test "$(sqlite3 /app/data/tahoma.sqlite "SELECT id FROM samples;")" = 42
      sqlite3 /app/data/tahoma.sqlite "INSERT INTO samples VALUES (43);"
    '
  `, undefined, ['PUID=12345', 'PGID=23456']);
  assert.equal(result.status, 0, result.output);
});

for (const [variable, expected] of [['PUID', '12345:1000'], ['PGID', '1000:12345']]) {
  test(`${variable} can be overridden independently`, () => {
    const result = runContainer(`
      exec tahoma-entrypoint sh -c 'test "$(id -u):$(id -g)" = ${expected}'
    `, undefined, [`${variable}=12345`]);
    assert.equal(result.status, 0, result.output);
  });
}

for (const variable of ['PUID', 'PGID']) {
  test(`invalid ${variable} stops startup before creating the database`, () => {
    for (const value of ['', '0', '-1', 'abc', '1.5', '01000', '2147483648', '99999999999999999999']) {
      const result = runContainer(`
        if tahoma-entrypoint true; then exit 2; else status=$?; fi
        test ! -e /app/data/tahoma.sqlite
        exit "$status"
      `, undefined, [`${variable}=${value}`]);
      assert.equal(result.status, 1, result.output);
      assert.match(result.output, new RegExp(`${variable} must be a decimal integer`));
    }
  });
}

test('non-root startup accepts matching ID overrides', () => {
  const result = runContainer(`
    chown node:node /app/data
    exec gosu node tahoma-entrypoint sh -c 'test "$(id -u):$(id -g)" = 1000:1000 && sqlite3 /app/data/tahoma.sqlite "CREATE TABLE samples (id INTEGER);"'
  `, undefined, ['PUID=1000', 'PGID=1000']);
  assert.equal(result.status, 0, result.output);
});

test('non-root startup rejects mismatched ID overrides', () => {
  const result = runContainer('exec gosu node tahoma-entrypoint true', undefined, ['PUID=12345']);
  assert.equal(result.status, 1, result.output);
  assert.match(result.output, /PUID\/PGID must match the current user/);
});

test('missing database is created after repairing directory permissions', () => {
  const result = runContainer(`
    chmod 500 /app/data
    tahoma-entrypoint true
    test "$(stat -c %U /app/data/tahoma.sqlite)" = node
    exec gosu node sqlite3 /app/data/tahoma.sqlite "CREATE TABLE samples (id INTEGER);"
  `);
  assert.equal(result.status, 0, result.output);
  assert.match(result.output, /attempting to repair/);
  assert.match(result.output, /No database found; creating/);
});

test('non-root startup creates a missing database', () => {
  const result = runContainer(`
    chown node:node /app/data
    gosu node tahoma-entrypoint true
    test "$(stat -c %U /app/data/tahoma.sqlite)" = node
  `);
  assert.equal(result.status, 0, result.output);
  assert.match(result.output, /No database found; creating/);
});

test('missing database on a read-only mount stops startup', () => {
  const result = runContainer('exec tahoma-entrypoint true', ['--tmpfs', '/app/data:ro']);
  assert.equal(result.status, 1, result.output);
  assert.match(result.output, /Database startup check failed/);
  assert.match(result.output, /Read-only file system/);
});

test('writable database starts the command as node without repair', () => {
  const result = runContainer(`
    ${createDatabase}
    chown node:node /app/data /app/data/tahoma.sqlite
    exec tahoma-entrypoint ${verifyApplicationUser}
  `);
  assert.equal(result.status, 0, result.output);
  assert.doesNotMatch(result.output, /attempting to repair/);
});

test('repairs database, directory, and sidecar permissions before dropping root', () => {
  const result = runContainer(`
    ${createDatabase}
    touch /app/data/tahoma.sqlite-wal /app/data/tahoma.sqlite-shm /app/data/tahoma.sqlite-journal
    chmod 400 /app/data/tahoma.sqlite*
    chmod 500 /app/data
    exec tahoma-entrypoint ${verifyApplicationUser}
  `);
  assert.equal(result.status, 0, result.output);
  assert.match(result.output, /attempting to repair/);
});

test('non-root owner can repair its own permissions', () => {
  const result = runContainer(`
    ${createDatabase}
    chown node:node /app/data /app/data/tahoma.sqlite
    chmod 400 /app/data/tahoma.sqlite
    chmod 500 /app/data
    exec gosu node tahoma-entrypoint ${verifyApplicationUser}
  `);
  assert.equal(result.status, 0, result.output);
  assert.match(result.output, /attempting to repair/);
});

test('unrepairable permissions stop startup', () => {
  const result = runContainer(`
    ${createDatabase}
    chmod 444 /app/data/tahoma.sqlite
    chmod 555 /app/data
    exec gosu node tahoma-entrypoint true
  `);
  assert.equal(result.status, 1, result.output);
  assert.match(result.output, /Cannot repair permissions/);
});

test('a read-only data volume stops startup even when starting as root', () => {
  const volume = `tahoma-startup-test-${randomUUID()}`;
  const mount = `type=volume,source=${volume},target=/app/data`;
  try {
    const setup = runContainer(createDatabase, ['--mount', mount]);
    assert.equal(setup.status, 0, setup.output);
    const result = runContainer('exec tahoma-entrypoint true', ['--mount', `${mount},readonly`]);
    assert.equal(result.status, 1, result.output);
    assert.match(result.output, /Database startup check failed/);
    assert.match(result.output, /Read-only file system/);
  } finally {
    const cleanup = spawnSync('docker', ['volume', 'rm', volume], {
      encoding: 'utf8',
      timeout: 30000,
    });
    assert.ifError(cleanup.error);
    assert.equal(cleanup.status, 0, cleanup.stdout + cleanup.stderr);
  }
});

test('a directory in place of the database stops startup', () => {
  const result = runContainer('mkdir /app/data/tahoma.sqlite; exec tahoma-entrypoint true');
  assert.equal(result.status, 1, result.output);
  assert.match(result.output, /is not a regular file/);
});

test('SQLite write-check errors stop startup', () => {
  const result = runContainer(`
    printf 'not a SQLite database' > /app/data/tahoma.sqlite
    exec tahoma-entrypoint true
  `);
  assert.equal(result.status, 1, result.output);
  assert.match(result.output, /SQLite cannot create or open/);
});
