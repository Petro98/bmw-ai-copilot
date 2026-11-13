'use strict';
/*
 * Smoke test of the uplink client on the head unit's runtime (Node 8.16.2), plain ES2017.
 *
 * It loads the bundled test entry (car/src/test-entry.ts, built to car/build/test-entry.js; the build
 * command is in that file), starts a local plain-HTTP server on 127.0.0.1, sends one POST through
 * HttpsClient in its test-only plain-HTTP mode and checks that the body, the bearer header and the
 * JSON content type arrived. Nothing leaves the machine.
 *
 *   scripts/run-node8.sh car/test/node8-uplink-smoke.js     -> uplink smoke ok on v8.16.2
 */
const assert = require('assert');
const http = require('http');
const path = require('path');

const entryPath = path.join(__dirname, '..', 'build', 'test-entry.js');
let uplink;
try {
  uplink = require(entryPath);
} catch (error) {
  console.error('uplink smoke: cannot load ' + entryPath + ' (build it first, see car/src/test-entry.ts): ' + error.message);
  process.exitCode = 1;
}

const quietLog = { info() {}, warn() {}, error() {} };

function run() {
  const received = [];
  const server = http.createServer((req, res) => {
    let body = '';
    req.setEncoding('utf8');
    req.on('data', (chunk) => {
      body += chunk;
    });
    req.on('end', () => {
      received.push({
        method: req.method,
        url: req.url,
        authorization: req.headers.authorization,
        contentType: req.headers['content-type'],
        body,
      });
      res.statusCode = 204;
      res.end();
    });
  });

  server.listen(0, '127.0.0.1', () => {
    const port = server.address().port;
    const client = new uplink.HttpsClient({
      baseUrl: 'http://127.0.0.1:' + port,
      lease: () => ({ online: true, dns: [] }),
      log: quietLog,
      https: http,
      plainHttpForTests: true,
      timeoutMs: 5000,
    });
    const batch = { snapshots: [{ takenAt: 1, note: 'Тест' }] };
    const finish = (error) => {
      client.close();
      server.close();
      if (error) {
        console.error('uplink smoke FAILED on ' + process.version + ': ' + ((error && error.stack) || error));
        process.exitCode = 1;
      } else {
        console.log('uplink smoke ok on ' + process.version);
      }
    };
    client
      .request('POST', '/car/v1/snapshots', batch, 'smoke-device.smoke-secret')
      .then((reply) => {
        assert.strictEqual(reply, undefined);
        assert.strictEqual(received.length, 1);
        assert.strictEqual(received[0].method, 'POST');
        assert.strictEqual(received[0].url, '/car/v1/snapshots');
        assert.strictEqual(received[0].authorization, 'Bearer smoke-device.smoke-secret');
        assert.strictEqual(received[0].contentType, 'application/json');
        assert.strictEqual(received[0].body, JSON.stringify(batch));
        assert.deepStrictEqual(JSON.parse(received[0].body), batch);
      })
      .then(() => finish(null), finish);
  });
}

if (uplink) run();
