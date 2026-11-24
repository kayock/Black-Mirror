'use strict';
/* Chat view: streaming, conversations, thinking display, stats, attachments. */
const ChatView = (() => {
  const $ = id => document.getElementById(id);
  const state = {
    convs: [], current: null, streaming: false, abort: null,
    servers: [], attachments: [], convMessages: [], lastPromptTokens: 0
  };

  async function init() {
    wireComposer();
    wireSide();
    await reloadConvs();
    window.Bridge.on('server-state', onServerState);
    onServerState(await window.Bridge.servers.list());
  }

  /* ---------- conversations ---------- */
  async function reloadConvs(keepCurrent) {
    state.convs = await window.Bridge.chat.list();
    if (!keepCurrent || !state.current || !state.convs.find(c => c.id === state.current.id)) {
      if (state.convs.length) await openConv(state.convs[0].id);
      else await newConv({ silent: true });
    }
    renderConvList();
  }

  async function openConv(id) {
    state.current = await window.Bridge.chat.get(id);
    state.convMessages = state.current.messages || [];
    renderMessages();
    renderConvList();
  }

  async function newConv({ silent } = {}) {
    const server = state.servers.find(s => s.status === 'running');
    state.current = await window.Bridge.chat.create({ model: server ? server.displayName : null });
    state.convMessages = [];
    renderMessages();
    if (!silent) renderConvList();
  }

  function renderConvList() {
    const list = $('conversation-list');
    const q = ($('chat-search').value || '').toLowerCase();
    list.innerHTML = '';
    for (const c of state.convs) {
      if (q && !(c.title || '').toLowerCase().includes(q)) continue;
      const item = BMUtil.el('div', { class: 'conv-item' + (state.current && state.current.id === c.id ? ' active' : ''), onclick: () => openConv(c.id) }, [
        BMUtil.el('div', { class: 'conv-title', text: c.title || 'Untitled' }),
        BMUtil.el('div', { class: 'conv-sub' }, [
          BMUtil.el('span', { text: c.model ? c.model.replace(/\.gguf$/, '') : 'no model' }),
          BMUtil.el('span', {}, [
            BMUtil.el('button', { class: 'conv-del', text: '✕', title: 'Delete conversation', onclick: async (e) => {
              e.stopPropagation();
              if (!(await uiConfirm('Delete conversation', 'Delete this conversation? Its messages will be removed from disk. This cannot be undone.'))) return;
              await window.Bridge.chat.remove(c.id);
              await reloadConvs();
            } }),
            BMUtil.el('span', { text: new Date(c.updatedAt || Date.now()).toLocaleDateString() })
          ])
        ])
      ]);
      list.appendChild(item);
    }
    if (!list.children.length) list.appendChild(BMUtil.el('div', { class: 'dim small', text: q ? 'No matches' : 'No conversations yet' }));
  }

  /* ---------- message rendering ---------- */
  function renderMessages() {
    const box = $('chat-messages');
    box.innerHTML = '';
    if (!state.convMessages.length) {
      box.appendChild(BMUtil.el('div', { class: 'dim', style: 'margin:auto;text-align:center;padding:40px' }, [
        BMUtil.el('div', { style: 'font-size:34px;margin-bottom:10px' }),
        BMUtil.el('div', { text: 'Start a conversation. All inference runs locally — nothing leaves this machine.' })
      ]));
    }
    for (const m of state.convMessages) box.appendChild(renderMessage(m));
    box.scrollTop = box.scrollHeight;
  }

  function renderMessage(m, live) {
    const wrap = BMUtil.el('div', { class: `msg msg-${m.role}` });
    if (m.attachments && m.attachments.length) {
      const atts = BMUtil.el('div', { class: 'msg-attachments' });
      for (const a of m.attachments) {
        if (a.kind === 'image') {
          const img = document.createElement('img');
          img.className = 'att-image'; img.src = a.dataUrl; img.alt = a.name;
          atts.appendChild(img);
        } else {
          atts.appendChild(BMUtil.el('span', { class: 'att-chip', text: '📄 ' + a.name }));
        }
      }
      wrap.appendChild(atts);
    }
    const bubble = BMUtil.el('div', { class: 'msg-bubble' });
    if (m.role === 'assistant') bubble.appendChild(BMMarkdown.render(m.content || ''));
    else bubble.textContent = m.content || '';
    if (live) bubble.appendChild(BMUtil.el('span', { class: 'stream-cursor' }));
    wrap.appendChild(bubble);

    if (m.reasoning) {
      wrap.appendChild(BMUtil.el('div', { class: 'small', style: 'color:var(--text-2)' }, [
        BMUtil.el('details', { style: 'width:100%' }, [
          BMUtil.el('summary', { text: '◈ thinking', style: 'color:var(--violet-0);cursor:pointer' }),
          BMUtil.el('div', { class: 'mono', text: m.reasoning, style: 'white-space:pre-wrap;font-size:12px;padding:8px 0;color:var(--text-1)' })
        ])
      ]));
    }

    const meta = BMUtil.el('div', { class: 'msg-meta' });
    const bits = [];
    if (m.model) bits.push(m.model.replace(/\.gguf$/, ''));
    if (m.usage) bits.push(`${m.usage.prompt_tokens} in · ${m.usage.completion_tokens} out`);
    if (m.tps) bits.push(BMUtil.formatTps(m.tps));
    if (m.usage) {
      const ctxMax = currentContextMax();
      if (ctxMax) bits.push(`ctx ${Math.min(100, Math.round(100 * m.usage.prompt_tokens / ctxMax))}%`);
    }
    if (m.stopped) bits.push('stopped');
    if (!live && bits.length) meta.appendChild(BMUtil.el('span', { text: bits.join(' · ') }));
    meta.appendChild(BMUtil.el('span', { text: new Date(m.ts || Date.now()).toLocaleTimeString() }));

    if (!live) {
      const actions = BMUtil.el('span', { class: 'msg-actions' });
      actions.appendChild(BMUtil.el('button', { class: 'link small', text: 'copy', onclick: () => navigator.clipboard.writeText(m.content) }));
      if (m.role === 'user') {
        actions.appendChild(BMUtil.el('button', { class: 'link small', text: 'edit & resend', onclick: () => editMessage(m) }));
      } else {
        actions.appendChild(BMUtil.el('button', { class: 'link small', text: 'regenerate', onclick: () => regenerate(m) }));
      }
      meta.appendChild(actions);
    }
    wrap.appendChild(meta);
    return wrap;
  }

  function currentContextMax() {
    const server = activeServer();
    if (!server || !server.params || !server.params.contextLength) return null;
    return server.params.contextLength;
  }

  function activeServer() {
    return state.servers.find(s => s.status === 'running' || s.status === 'starting') || null;
  }

  function editMessage(m) {
    const box = $('chat-messages');
    const idx = state.convMessages.findIndex(x => x.id === m.id);
    const orig = state.convMessages[idx];
    const editor = BMUtil.el('div', { class: 'msg msg-user msg-edit' }, [
      BMUtil.el('textarea', { text: orig.content }),
      BMUtil.el('div', { style: 'display:flex;gap:8px;margin-top:6px' }, [
        BMUtil.el('button', { class: 'btn btn-primary btn-sm', text: 'Resend', onclick: async () => {
          const newContent = editor.querySelector('textarea').value;
          // truncate history at this message (inclusive), then resend
          await window.Bridge.chat.truncateFrom(state.current.id, m.id, { inclusive: true });
          const mm = await window.Bridge.chat.append(state.current.id, { role: 'user', content: newContent, attachments: orig.attachments });
          state.convMessages = state.convMessages.slice(0, idx).concat([mm]);
          renderMessages();
          generate();
        } }),
        BMUtil.el('button', { class: 'btn btn-ghost btn-sm', text: 'Cancel', onclick: () => renderMessages() })
      ])
    ]);
    box.replaceChild(editor, box.children[idx]);
    editor.querySelector('textarea').focus();
  }

  async function regenerate(m) {
    const idx = state.convMessages.findIndex(x => x.id === m.id);
    const prevUser = [...state.convMessages.slice(0, idx)].reverse().find(x => x.role === 'user');
    if (!prevUser) return;
    await window.Bridge.chat.truncateFrom(state.current.id, prevUser.id, { inclusive: false });
    state.convMessages = state.convMessages.slice(0, idx - 1 >= 0 ? idx : idx);
    state.convMessages = state.convMessages.filter(x => x.id !== m.id);
    renderMessages();
    generate();
  }

  /* ---------- composer ---------- */
  function wireComposer() {
    const input = $('composer-input');
    input.addEventListener('keydown', e => {
      if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); }
    });
    input.addEventListener('input', () => {
      input.style.height = 'auto';
      input.style.height = Math.min(180, input.scrollHeight) + 'px';
    });
    $('btn-send').addEventListener('click', () => send());
    $('btn-stop').addEventListener('click', () => { if (state.abort) state.abort.abort(); });
    $('btn-new-chat').addEventListener('click', () => newConv());
    $('btn-new-chat-2').addEventListener('click', () => newConv());
    $('btn-attach').addEventListener('click', () => $('attach-input').click());
    $('attach-input').addEventListener('change', async e => {
      for (const file of e.target.files) {
        if (file.type.startsWith('image/')) {
          const dataUrl = await fileToDataUrl(file);
          state.attachments.push({ kind: 'image', name: file.name, dataUrl, mime: file.type });
        } else {
          const text = await file.text();
          state.attachments.push({ kind: 'text', name: file.name, content: text.slice(0, 200000) });
        }
      }
      e.target.value = '';
      renderAttachments();
    });
  }

  function fileToDataUrl(file) {
    return new Promise((resolve, reject) => {
      const r = new FileReader();
      r.onload = () => resolve(r.result);
      r.onerror = reject;
      r.readAsDataURL(file);
    });
  }

  function renderAttachments() {
    const box = $('attachments-preview');
    box.innerHTML = '';
    state.attachments.forEach((a, i) => {
      const chip = BMUtil.el('span', { class: 'att-chip' }, [
        BMUtil.el('span', { text: (a.kind === 'image' ? '🖼 ' : '📄 ') + a.name + '  ' }),
        BMUtil.el('button', { class: 'conv-del', text: '✕', onclick: () => { state.attachments.splice(i, 1); renderAttachments(); } })
      ]);
      box.appendChild(chip);
    });
  }

  function onServerState(servers) {
    state.servers = servers || [];
    const running = state.servers.find(s => s.status === 'running');
    const badge = $('chat-server-badge');
    if (running) {
      badge.className = 'badge badge-on';
      badge.textContent = `${running.displayName} · :${running.port}`;
      $('api-endpoint-chip').textContent = running.baseUrl + '/v1';
      $('composer-warn').classList.add('hidden');
      populateModelSelect(running);
    } else {
      badge.className = 'badge badge-off';
      badge.textContent = 'no server running';
      $('composer-warn').classList.remove('hidden');
      $('composer-warn').textContent = 'No local server is running. Launch one from Servers → Launch model server. Chat requires a local inference process.';
      $('chat-model-select').innerHTML = '<option>—</option>';
    }
  }

  function populateModelSelect(server) {
    const sel = $('chat-model-select');
    sel.innerHTML = `<option>${BMUtil.esc(server.displayName)}</option>`;
    sel.disabled = true;
  }

  async function send() {
    const input = $('composer-input');
    const text = input.value.trim();
    if (!text || state.streaming) return;
    const server = activeServer();
    if (!server) { toast('Start a server first (Servers view)', 'warn'); return; }
    input.value = '';
    input.style.height = 'auto';

    const attachments = state.attachments.splice(0, state.attachments.length);
    renderAttachments();
    const userMsg = await window.Bridge.chat.append(state.current.id, { role: 'user', content: text, attachments });
    state.convMessages.push(userMsg);
    renderMessages();
    await generate(text, attachments);
  }

  function buildApiMessages(userText, attachments) {
    const messages = [];
    if (state.current && state.current.systemPrompt) {
      messages.push({ role: 'system', content: state.current.systemPrompt });
    }
    for (const m of state.convMessages) {
      if (m.role === 'user') {
        const content = m.content;
        if (m.attachments && m.attachments.some(a => a.kind === 'image')) {
          // multimodal: text + image_url parts
          const parts = [{ type: 'text', text: content }];
          for (const a of m.attachments.filter(a => a.kind === 'image')) {
            parts.push({ type: 'image_url', image_url: { url: a.dataUrl } });
          }
          messages.push({ role: 'user', content: parts });
        } else {
          let full = content;
          for (const a of (m.attachments || []).filter(a => a.kind === 'text')) {
            full += `\n\n--- attached: ${a.name} ---\n${a.content}\n--- end of ${a.name} ---`;
          }
          messages.push({ role: 'user', content: full });
        }
      } else if (m.role === 'assistant' && m.content) {
        messages.push({ role: 'assistant', content: m.content });
      }
    }
    return messages;
  }

  async function generate(prewrittenText, prewrittenAttachments) {
    const server = activeServer();
    if (!server) return;
    const messages = buildApiMessages();
    // ensure last message is the user turn we just added
    const box = $('chat-messages');
    const live = renderMessage({ role: 'assistant', content: '', ts: Date.now(), model: server.displayName }, true);
    box.appendChild(live);
    box.scrollTop = box.scrollHeight;
    const bubble = live.querySelector('.msg-bubble');
    bubble.innerHTML = '<span class="typing-dots"><span></span><span></span><span></span></span>';

    state.streaming = true;
    $('btn-send').classList.add('hidden');
    $('btn-stop').classList.remove('hidden');
    const showThinking = state.current && state.current.showThinking !== false;
    state.abort = new AbortController();
    const t0 = Date.now();
    let streamed = '', streamedReasoning = '';

    const onDelta = (d) => {
      streamed += d;
      bubble.innerHTML = '';
      bubble.appendChild(BMMarkdown.render(streamed));
      bubble.appendChild(BMUtil.el('span', { class: 'stream-cursor' }));
      box.scrollTop = box.scrollHeight;
    };
    const onReasoning = (d) => {
      if (!showThinking) return;
      streamedReasoning += d;
      const tp = $('chat-thinking');
      tp.classList.remove('hidden');
      $('thinking-content').textContent = streamedReasoning;
      tp.scrollTop = tp.scrollHeight;
      // Reasoning arriving before any content: show an explicit "thinking"
      // state so the response does not look missing or stalled.
      if (!streamed && state.streaming) {
        bubble.innerHTML = '<span class="thinking-status">◈ thinking…</span><span class="stream-cursor"></span>';
      }
    };

    const params = (server.params || {});
    try {
      let result;
      if (window.PreviewMode && typeof window.Bridge.fakeChatStream === 'function') {
        // Interface preview: simulated stream, clearly labeled by the banner.
        result = await window.Bridge.fakeChatStream(
          d => onDelta(d),
          d => onReasoning(d),
          state.abort.signal,
          params.thinkingMode || 'auto'
        );
        result = { ...result, stopped: false };
      } else {
        result = await StreamClient.chat({
          baseUrl: server.baseUrl,
          model: server.displayName,
          messages,
          params,
          thinking: params.thinkingMode || 'auto',
          engineFamily: server.family || null,
          signal: state.abort.signal,
          onDelta,
          onReasoning
        });
      }
      const elapsed = (Date.now() - t0) / 1000;
      const usage = result.usage || { prompt_tokens: null, completion_tokens: Math.round(streamed.length / 4) };
      const tps = usage.completion_tokens && elapsed > 0 ? usage.completion_tokens / elapsed : null;
      state.lastPromptTokens = usage.prompt_tokens || state.lastPromptTokens;
      const saved = await window.Bridge.chat.append(state.current.id, {
        role: 'assistant', content: streamed || (result.stopped ? '(stopped)' : '(empty response)'),
        reasoning: streamedReasoning || null, usage, tps, model: server.displayName, stopped: result.stopped
      });
      state.convMessages.push(saved);
      bubble.innerHTML = '';
      const rendered = renderMessage(saved);
      live.replaceWith(rendered);
      updateStats(saved);
      box.scrollTop = box.scrollHeight;
    } catch (e) {
      if (e.name === 'AbortError' || /aborted/i.test(e.message || '')) {
        bubble.textContent = streamed + '  (stopped)';
        if (streamed) {
          const saved = await window.Bridge.chat.append(state.current.id, { role: 'assistant', content: streamed, model: server.displayName, stopped: true, usage: { prompt_tokens: state.lastPromptTokens, completion_tokens: Math.round(streamed.length / 4) } });
          state.convMessages.push(saved);
          live.replaceWith(renderMessage(saved));
        } else {
          live.remove();
        }
      } else {
        bubble.innerHTML = `<span style="color:var(--err)">✕ ${BMUtil.esc(e.message)}</span>`;
        toast(e.message, 'err');
      }
    } finally {
      state.streaming = false;
      state.abort = null;
      $('btn-send').classList.remove('hidden');
      $('btn-stop').classList.add('hidden');
      setTimeout(() => $('chat-thinking').classList.add('hidden'), 4000);
    }
  }

  function updateStats(m) {
    const el = $('chat-stats');
    const total = state.convMessages.reduce((a, x) => a + ((x.usage && x.usage.completion_tokens) || 0), 0);
    const ctx = currentContextMax();
    const used = m.usage ? m.usage.prompt_tokens + (m.usage.completion_tokens || 0) : null;
    el.innerHTML = [
      total ? `session ${total} tok` : null,
      m.usage ? `last: ${m.usage.prompt_tokens}↑ ${m.usage.completion_tokens}↓` : null,
      m.tps ? BMUtil.formatTps(m.tps) : null,
      ctx && used ? `context ${Math.min(100, Math.round(100 * used / ctx))}% of ${ctx.toLocaleString()}` : null
    ].filter(Boolean).join('  ·  ');
  }

  function wireSide() {
    $('chat-search').addEventListener('input', BMUtil.debounce(() => renderConvList(), 200));
    $('thinking-toggle').addEventListener('click', () => {
      const c = $('thinking-content');
      c.style.display = c.style.display === 'none' ? 'block' : 'none';
    });
  }

  return { init };
})();
