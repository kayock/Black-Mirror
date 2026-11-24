'use strict';
/**
 * OpenAI-compatible streaming client (runs in the renderer, talks directly
 * to the local inference server — the app never proxies model traffic).
 *
 * Features: SSE parsing, abort (stop generation), thinking/reasoning channel
 * separation (llama.cpp `reasoning_content`, Ollama `reasoning`, <think> tags),
 * token usage from the final chunk, first-token latency, wall-clock tok/s.
 *
 * Environment-agnostic: also loadable from Node for unit tests.
 */
class StreamClient {
  /**
   * @param {object} opts { baseUrl, model, messages, params (sampling),
   *   signal (AbortSignal), onDelta(text), onReasoning(text), onUsage(usage),
   *   fetchImpl }
   * @returns {Promise<{content, reasoning, usage, firstTokenMs, elapsedMs, tps, stopped}>}
   */
  static async chat(opts) {
    const fetchImpl = opts.fetchImpl || (typeof fetch !== 'undefined' ? fetch : null);
    if (!fetchImpl) throw new Error('No fetch implementation available');
    const started = Date.now();
    let firstTokenAt = null;
    let content = '';
    let reasoning = '';
    let usage = null;
    let stopped = false;
    let serverDone = false;

    const body = {
      model: opts.model || 'default',
      messages: opts.messages || [],
      stream: true,
      ...buildSampling(opts.params)
    };
    // Thinking tri-state: 'on' requests reasoning; 'off' EXPLICITLY disables
    // it (required for Ollama models that think by default, and for llama.cpp
    // chat templates that accept enable_thinking). 'auto'/undefined leaves
    // the engine default untouched.
    // llama.cpp streams include usage only when explicitly requested.
    if (opts.engineFamily === 'llama.cpp') body.stream_options = { include_usage: true };
    if (opts.thinking === 'on') body.think = true;
    else if (opts.thinking === 'off') {
      body.think = false;
      body.chat_template_kwargs = { enable_thinking: false };
    }

    const res = await fetchImpl(`${opts.baseUrl}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: opts.signal
    });

    if (!res.ok) {
      let detail = `HTTP ${res.status}`;
      try { detail += ' — ' + (await res.text()).slice(0, 300); } catch (_) { /* ignore */ }
      throw new Error(`Inference request failed: ${detail}`);
    }
    if (!res.body) throw new Error('Streaming not supported by this response');

    // <think> tag state (some models emit raw DeepSeek-style tags)
    let inThink = false;
    let sawThinkClose = false;

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buf = '';
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        let idx;
        while ((idx = buf.indexOf('\n')) >= 0) {
          const line = buf.slice(0, idx).trim();
          buf = buf.slice(idx + 1);
          if (!line.startsWith('data:')) continue;
          const payload = line.slice(5).trim();
          if (payload === '[DONE]') { serverDone = true; continue; }
          let j;
          try { j = JSON.parse(payload); } catch (_) { continue; }
          if (j.usage) usage = j.usage;
          if (j.error) throw new Error(j.error.message || 'engine error');
          const choice = (j.choices && j.choices[0]) || {};
          const delta = choice.delta || {};
          // reasoning channel: llama.cpp deepseek format / ollama
          const rChunk = delta.reasoning_content !== undefined ? delta.reasoning_content
            : (delta.reasoning !== undefined ? delta.reasoning : null);
          if (rChunk) {
            reasoning += rChunk;
            if (opts.onReasoning) opts.onReasoning(rChunk);
          }
          if (typeof delta.content === 'string' && delta.content.length) {
            let text = delta.content;
            // strip <think>…</think> when the engine didn't separate it
            while (text.length) {
              if (inThink) {
                const close = text.indexOf('</think>');
                if (close >= 0) {
                  inThink = false; sawThinkClose = true;
                  const seg = text.slice(0, close);
                  if (seg) { reasoning += seg; if (opts.onReasoning) opts.onReasoning(seg); }
                  text = text.slice(close + 8);
                }
                else { reasoning += text; if (opts.onReasoning) opts.onReasoning(text); text = ''; }
              } else {
                const open = text.indexOf('<think>');
                if (open >= 0) {
                  if (open > 0) { content += text.slice(0, open); if (opts.onDelta) opts.onDelta(text.slice(0, open)); }
                  inThink = true;
                  text = text.slice(open + 7);
                } else {
                  content += text;
                  if (firstTokenAt === null) firstTokenAt = Date.now();
                  if (opts.onDelta) opts.onDelta(text);
                  text = '';
                }
              }
            }
          }
        }
      }
    } catch (e) {
      if (opts.signal && opts.signal.aborted) stopped = true;
      else if (e && (e.name === 'AbortError')) stopped = true;
      else throw e;
    }
    const elapsedMs = Date.now() - started;
    const tokens = usage && usage.completion_tokens ? usage.completion_tokens : null;
    return {
      content,
      reasoning: reasoning || null,
      usage,
      firstTokenMs: firstTokenAt ? firstTokenAt - started : null,
      elapsedMs,
      tps: tokens && elapsedMs > 0 ? tokens / (elapsedMs / 1000) : null,
      stopped,
      serverDone
    };
  }

  /** Non-streaming helper (benchmarks, connection tests). */
  static async complete(opts) {
    const fetchImpl = opts.fetchImpl || (typeof fetch !== 'undefined' ? fetch : null);
    const res = await fetchImpl(`${opts.baseUrl}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: opts.model || 'default', messages: opts.messages || [], stream: false, ...buildSampling(opts.params) }),
      signal: opts.signal
    });
    if (!res.ok) throw new Error(`Request failed: HTTP ${res.status}`);
    return res.json();
  }
}

function buildSampling(p) {
  const out = {};
  if (!p) return out;
  if (p.temperature !== undefined) out.temperature = p.temperature;
  if (p.topP !== undefined) out.top_p = p.topP;
  if (p.topK !== undefined) out.top_k = p.topK;
  if (p.repeatPenalty !== undefined) out.repeat_penalty = p.repeatPenalty;
  if (p.maxTokens !== undefined) out.max_tokens = p.maxTokens;
  return out;
}

if (typeof module !== 'undefined' && module.exports) module.exports = { StreamClient };
