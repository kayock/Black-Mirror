'use strict';
// Packaged Windows runtime: recover a real detached mock server, close the
// application normally, reopen it, and stop the same owned PID via renderer IPC.
// No production data, real model downloads, or credentials are used.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { findFreePort } = require('../main/server/ports');
const ownership = require('../main/server/ownership');
const { Config } = require('../main/core/config');
const sleep = ms => new Promise(r => setTimeout(r, ms));
async function until(fn, label, ms = 60000) {
  const end = Date.now() + ms;
  let last;
  while (Date.now() < end) {
    try { const value = await fn(); if (value) return value; } catch (e) { last = e; }
    await sleep(250);
  }
  throw new Error(label + ' timed out: ' + (last?.message || 'no result'));
}
async function evalPage(url, expression) {
  const socket = new WebSocket(url);
  try {
    await new Promise((resolve, reject) => {
      socket.addEventListener('open', resolve, { once: true });
      socket.addEventListener('error', reject, { once: true });
    });
    return await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('CDP timeout')), 15000);
      socket.addEventListener('message', e => {
        const msg = JSON.parse(e.data);
        if (msg.id !== 1) return;
        clearTimeout(timer);
        if (msg.error || msg.result?.exceptionDetails) reject(new Error(JSON.stringify(msg.error || msg.result.exceptionDetails)));
        else resolve(msg.result.result.value);
      });
      socket.send(JSON.stringify({ id: 1, method: 'Runtime.evaluate', params: { expression, awaitPromise: true, returnByValue: true } }));
    });
  } finally { socket.close(); }
}
async function main() {
  assert.equal(process.platform, 'win32');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bm-package-'));
  const exe = path.resolve('dist/win-unpacked/Black Mirror.exe');
  assert.ok(fs.existsSync(exe), 'packaged executable exists');
  const config = new Config(dir);
  config.set('lifecycle.keepServersOnExit', true);
  config.set('firstRunDone', true);
  const port = await findFreePort(19000, '127.0.0.1');
  const debugPort = await findFreePort(20000, '127.0.0.1');
  assert.ok(port && debugPort);
  const baseUrl = 'http://127.0.0.1:' + port;
  const model = path.join(dir, 'fixture.gguf');
  const logDir = path.join(dir, 'server-logs');
  fs.mkdirSync(logDir, { recursive: true });
  const logFile = path.join(logDir, 'fixture.log');
  const fd = fs.openSync(logFile, 'a');
  let server, app;
  let output = '';
  try {
    server = spawn(process.execPath, [path.join(__dirname, 'helpers/mockengine.js'), '--port', String(port), '--model', model], { detached: true, stdio: ['ignore', fd, fd], windowsHide: true });
    fs.closeSync(fd);
    await until(async () => (await fetch(baseUrl + '/health')).ok, 'fixture health');
    const snap = await until(() => ownership.snapshotProcess(server.pid), 'fixture identity');
    const record = { id: 'srv-1', pid: server.pid, engineId: 'llamacpp-cpu', family: 'llama.cpp', model, modelPath: model, port, bind: '127.0.0.1', startedAt: Date.now(), exePath: snap.exe, startTime: snap.startTime, cmdline: snap.cmdline, params: { contextLength: 16384 }, readyUrl: baseUrl + '/health', logFile, persistent: true };
    assert.equal(ownership.verifyOwnership(record, snap).owned, true);
    fs.writeFileSync(path.join(dir, 'managed-processes.json'), JSON.stringify({ records: [record] }));
    async function launch() {
      app = spawn(exe, ['--remote-debugging-port=' + debugPort, '--remote-debugging-address=127.0.0.1', '--user-data-dir=' + path.join(dir, 'electron')], { env: { ...process.env, BLACK_MIRROR_DATA_DIR: dir }, stdio: ['ignore','pipe','pipe'] });
      app.stdout.on('data', d => { output += d; });
      app.stderr.on('data', d => { output += d; });
      return until(async () => {
        const targets = await (await fetch('http://127.0.0.1:' + debugPort + '/json/list')).json();
        const page = targets.find(t => t.type === 'page' && t.url.includes('index.html'));
        if (!page) return false;
        return await evalPage(page.webSocketDebuggerUrl, '!!window.blackMirror') ? page.webSocketDebuggerUrl : false;
      }, 'packaged renderer');
    }
    async function check(url) {
      const list = await evalPage(url, 'window.blackMirror.servers.list()');
      const recovered = list.find(p => p.id === 'srv-1');
      assert.ok(recovered, 'managed server recovered');
      assert.equal(recovered.pid, server.pid);
      assert.equal(recovered.params.contextLength, 16384);
      assert.equal(recovered.pidRecovered, true);
      assert.equal((await fetch(baseUrl + '/health')).status, 200);
      const logs = await evalPage(url, "window.blackMirror.servers.logs('srv-1')");
      assert.ok(logs.length > 0, 'persistent logs accessible');
    }
    async function close(url) {
      // Schedule close after the CDP response has returned.
      await evalPage(url, 'setTimeout(() => window.close(), 100); true');
      await until(() => app.exitCode !== null, 'normal application exit');
      assert.equal(app.exitCode, 0);
    }
    const first = await launch();
    await check(first);
    await close(first);
    assert.equal((await fetch(baseUrl + '/health')).status, 200, 'server survived app exit');
    const second = await launch();
    await check(second);
    const stop = await evalPage(second, "window.blackMirror.servers.stop('srv-1')");
    assert.equal(stop.confirmed, true, 'owned process stopped');
    await close(second);
    console.log('Packaged Windows persistence smoke PASSED');
  } catch (e) {
    console.error(output.slice(-12000));
    throw e;
  } finally {
    if (app && app.exitCode === null) app.kill();
    if (server && server.exitCode === null) server.kill();
    await sleep(500);
    fs.rmSync(dir, { recursive: true, force: true });
  }
}
main().catch(e => { console.error(e); process.exitCode = 1; });
