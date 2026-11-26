'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { Conversations } = require('../main/core/conversations');
const { StreamClient } = require('../renderer/js/streamclient');

test('response checkpoints survive reopening and finalize one message with accurate usage', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bm-recovery-'));
  try {
    let store = new Conversations(dir);
    const c = store.create();
    const draft = store.appendMessage(c.id, { role: 'assistant', content: 'partial', stopped: true });
    store.updateMessage(c.id, draft.id, { content: 'partial response', reasoning: 'reasoning' });
    store = new Conversations(dir);
    assert.equal(store.get(c.id).messages[0].content, 'partial response');
    assert.equal(store.get(c.id).messages[0].stopped, true);
    const patch = { content: 'finished', stopped: false, usage: { prompt_tokens: 10, completion_tokens: 20 } };
    store.updateMessage(c.id, draft.id, patch);
    store.updateMessage(c.id, draft.id, patch);
    const saved = store.get(c.id);
    assert.equal(saved.messages.length, 1);
    assert.equal(saved.messages[0].content, 'finished');
    assert.equal(saved.messages[0].stopped, false);
    assert.deepEqual(saved.stats, { promptTokens: 10, completionTokens: 20 });
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('stream callback failure cancels and releases reader', async () => {
  let cancelled = false, released = false;
  const reader = {
    read: async () => ({ done: false, value: new TextEncoder().encode('data: {"choices":[{"delta":{"content":"partial"}}]}\n\n') }),
    cancel: async () => { cancelled = true; },
    releaseLock: () => { released = true; }
  };
  await assert.rejects(StreamClient.chat({
    baseUrl: 'http://127.0.0.1:1',
    fetchImpl: async () => ({ ok: true, body: { getReader: () => reader } }),
    onDelta: () => { throw new Error('renderer failed'); }
  }), /renderer failed/);
  assert.equal(cancelled, true);
  assert.equal(released, true);
});

// Minimal DOM double enforcing the hierarchy rule that caused the v1.2.2 crash.
class Node {
  constructor(tag) { this.tag = tag; this.children = []; this.style = {}; this.attributes = []; this.parent = null; }
  appendChild(n) {
    if (n.parent) n.parent.children.splice(n.parent.children.indexOf(n), 1);
    n.parent = this; this.children.push(n); return n;
  }
  replaceWith(n) {
    for (let p = this.parent; p; p = p.parent) if (p === n) throw new Error('The new child element contains the parent');
    const parent = this.parent;
    parent.children[parent.children.indexOf(this)] = n;
    n.parent = parent; this.parent = null;
  }
  querySelectorAll(sel) {
    if (sel === 'pre') return this.children.filter(n => n.tag === 'pre');
    return [];
  }
  querySelector() { return null; }
  addEventListener() {}
}
function markdownHarness(parse) {
  const fragment = new Node('fragment');
  fragment.appendChild(new Node('pre'));
  const document = {
    createElement: tag => tag === 'template' ? { content: fragment } : new Node(tag),
    createDocumentFragment: () => new Node('fragment')
  };
  const context = vm.createContext({ document, window: {}, marked: { parse }, console: { warn() {} } });
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../renderer/js/markdown.js'), 'utf8'), context);
  return text => vm.runInContext('BMMarkdown.render(' + JSON.stringify(text) + ')', context);
}
test('fenced code wrapping inserts wrapper before adopting the pre node', () => {
  const render = markdownHarness(() => '<pre>code</pre>');
  const result = render('code');
  assert.equal(result.children[0].className, 'code-block');
  assert.equal(result.children[0].children[0].tag, 'pre');
  assert.equal(result.children[0].children[1].className, 'code-copy');
});
test('parser failure returns literal text without interpreting markup', () => {
  const render = markdownHarness(() => { throw new Error('parser failed'); });
  const result = render('<script>test</script>');
  assert.equal(result.children[0].textContent, '<script>test</script>');
  assert.equal(result.children[0].style.whiteSpace, 'pre-wrap');
});
