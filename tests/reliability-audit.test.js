'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { verifyOwnership } = require('../main/server/ownership');
const { StreamClient } = require('../renderer/js/streamclient');

test('recovery refuses incomplete or mismatched process identity', () => {
  const record = { pid: 12, exePath: 'C:/engines/llama-server.exe', startTime: '123', modelPath: 'C:/models/model.gguf' };
  const snapshot = { pid: 12, exe: record.exePath, startTime: '123', cmdline: ['llama-server.exe', '-m', record.modelPath] };
  assert.equal(verifyOwnership(record, snapshot).owned, true);
  assert.equal(verifyOwnership(record, { ...snapshot, startTime: null }).owned, false);
  assert.equal(verifyOwnership(record, { ...snapshot, exe: 'C:/other/llama-server.exe' }).owned, false);
  assert.equal(verifyOwnership(record, { ...snapshot, cmdline: ['llama-server.exe', '-m', record.modelPath + '.bak'] }).owned, false);
});
test('non-stream request normalizes API URL and honors thinking off', async () => {
  let captured;
  const response = await StreamClient.complete({
    baseUrl: 'http://localhost:8081/v1/', model: 'actual-id',
    params: { thinkingMode: 'off', maxTokens: 17 },
    fetchImpl: async (url, options) => {
      captured = { url, body: JSON.parse(options.body) };
      return { ok: true, json: async () => ({ choices: [] }) };
    }
  });
  assert.equal(captured.url, 'http://localhost:8081/v1/chat/completions');
  assert.equal(captured.body.model, 'actual-id');
  assert.equal(captured.body.think, false);
  assert.equal(captured.body.chat_template_kwargs.enable_thinking, false);
  assert.equal(captured.body.max_tokens, 17);
  assert.deepEqual(response, { choices: [] });
});
