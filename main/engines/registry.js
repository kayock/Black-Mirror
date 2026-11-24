'use strict';
/**
 * Engine registry: discovery, installation state, versioning, selection.
 *
 * Installed layout (under <dataDir>/engines):
 *   <dataDir>/engines/<engineId>/<tag>/...      extracted engine binaries
 *   <dataDir>/engines.json                      installed registry + settings
 *
 * engines.json shape:
 * {
 *   "llamacpp-vulkan": {
 *      "customPath": null,                       // user override, highest priority
 *      "versions": [ { "tag":"b12359", "dir": "...", "installedAt": 1, "label":"b12359" } ],
 *      "activeTag": "b12359",
 *      "settings": { "port": 8082, "bind": "127.0.0.1" }
 *   }
 * }
 *
 * Descriptors: builtin JSON files in main/engines/builtin + any *.json the
 * user drops into <dataDir>/engines.d/ (extensibility without code changes).
 */
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { JsonStore } = require('../core/store');
const { EngineError, createAdapter } = require('./adapters');

const DEFAULT_ENGINE_STORE = {};

class EngineRegistry {
  constructor(dataDir, logger, opts = {}) {
    this.dataDir = dataDir;
    this.logger = logger;
    this.enginesDir = path.join(dataDir, 'engines');
    fs.mkdirSync(this.enginesDir, { recursive: true });
    this.store = new JsonStore(path.join(dataDir, 'engines.json'), DEFAULT_ENGINE_STORE);
    this.store.load();
    this.builtinDir = opts.builtinDir || path.join(__dirname, 'builtin');
    this.userDir = path.join(dataDir, 'engines.d');
    this.fetchImpl = opts.fetchImpl || fetch;
    // Production: only load descriptors for the running OS. Tests may relax.
    this.osFilter = opts.osFilter !== undefined ? opts.osFilter : process.platform;
    this._descriptors = null;
  }

  /** All descriptors (builtin + user). */
  descriptors() {
    if (this._descriptors) return this._descriptors;
    const list = [];
    const read = (dir) => {
      try {
        for (const f of fs.readdirSync(dir).filter(f => f.endsWith('.json'))) {
          try { list.push(JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'))); }
          catch (e) { if (this.logger) this.logger.warn('registry', `bad descriptor ${f}: ${e.message}`); }
        }
      } catch (_) { /* dir missing */ }
    };
    read(this.builtinDir);
    read(this.userDir);
    const seen = new Set();
    this._descriptors = list.filter(d => {
      if (!d.id || seen.has(d.id)) return false;
      if (this.osFilter && (!Array.isArray(d.os) || !d.os.includes(this.osFilter))) return false;
      seen.add(d.id);
      return true;
    });
    return this._descriptors;
  }

  descriptor(engineId) {
    const d = this.descriptors().find(x => x.id === engineId);
    if (!d) throw new EngineError(`Unknown engine "${engineId}"`, 'unknown-engine');
    return d;
  }

  /** Installed-state record for an engine (creates lazily). */
  state(engineId) {
    if (!this.store.data[engineId]) {
      this.store.data[engineId] = { customPath: null, versions: [], activeTag: null, settings: {} };
      this.store.save();
    }
    return this.store.data[engineId];
  }

  activeVersionDir(engineId) {
    const st = this.store.data[engineId];
    if (!st || !st.activeTag) return null;
    const v = (st.versions || []).find(v => v.tag === st.activeTag);
    return v ? v.dir : null;
  }

  /** Register an installed version and optionally make it active. */
  registerVersion(engineId, tag, dir, { activate = true, label } = {}) {
    const st = this.state(engineId);
    const existing = st.versions.find(v => v.tag === tag);
    if (existing) {
      existing.dir = dir;
      existing.installedAt = existing.installedAt || Date.now();
    } else {
      st.versions.push({ tag, dir, installedAt: Date.now(), label: label || tag });
    }
    if (activate || !st.activeTag) st.activeTag = tag;
    this.store.save();
    return this.state(engineId);
  }

  removeVersion(engineId, tag) {
    const st = this.state(engineId);
    st.versions = st.versions.filter(v => v.tag !== tag);
    if (st.activeTag === tag) {
      st.activeTag = st.versions.length ? st.versions[st.versions.length - 1].tag : null;
    }
    this.store.save();
    return st;
  }

  /** Rollback = activate an older installed version. */
  setActiveVersion(engineId, tag) {
    const st = this.state(engineId);
    if (!st.versions.find(v => v.tag === tag)) {
      throw new EngineError(`Version ${tag} of ${engineId} is not installed`, 'not-installed');
    }
    st.activeTag = tag;
    this.store.save();
    return st;
  }

  setCustomPath(engineId, customPath) {
    const st = this.state(engineId);
    st.customPath = customPath || null;
    this.store.save();
    return st;
  }

  updateSettings(engineId, settings) {
    const st = this.state(engineId);
    st.settings = { ...st.settings, ...settings };
    this.store.save();
    return st;
  }

  /** Create the right adapter bound to current install state (capability-probed). */
  adapter(engineId, capabilities) {
    const d = this.descriptor(engineId);
    const installed = {
      customPath: this.store.data[engineId]?.customPath || null,
      activeVersionDir: this.activeVersionDir(engineId)
    };
    return createAdapter(d, installed, capabilities);
  }

  /** Probe the engine version via its CLI. Returns null when unavailable. */
  probeVersion(engineId) {
    const d = this.descriptor(engineId);
    const installed = {
      customPath: this.store.data[engineId]?.customPath || null,
      activeVersionDir: this.activeVersionDir(engineId)
    };
    const adapter = createAdapter(d, installed);
    return this._probe(d, adapter);
  }

  /**
   * Full status snapshot for the UI: one entry per engine with install
   * state, versions, version probe, hardware compatibility, executable.
   *
   * statusCategory taxonomy (mutually exclusive):
   *  - 'not-installed'  no binary known to Black Mirror
   *  - 'error'          binary exists but probing failed unexpectedly
   *  - 'available'      binary works; safe on any hardware
   *  - 'compatible'     works + acceleration runtime confirmed present
   *  - 'experimental'   binary works but the acceleration runtime is
   *                     unverified on this machine — serve may fail with a
   *                     clear error (reported honestly, never hidden)
   */
  async status(opts = {}) {
    const hardware = this.hardwareInfo();
    const out = [];
    for (const d of this.descriptors()) {
      const st = this.store.data[d.id] || {};
      const versions = st.versions || [];
      const installed = {
        customPath: st.customPath || null,
        activeVersionDir: this.activeVersionDir(d.id)
      };
      let adapter = null;
      let executable = null;
      let version = null;
      let error = null;
      let caps = null;
      try {
        adapter = createAdapter(d, installed);
        executable = adapter.executablePath();
        version = this._probe(d, adapter);
        if (d.family === 'llama.cpp') {
          const { probe: probeCaps, summarize } = require('./capabilities');
          caps = probeCaps(executable, opts);
          adapter.caps = caps;
          adapter._supported = require('./capabilities').supportedServerFlags(caps);
        }
      } catch (e) {
        error = e.message;
      }
      const hwCategory = this._hardwareCategory(d, hardware, caps);
      let statusCategory;
      if (error && !versions.length && !st.customPath) statusCategory = 'not-installed';
      else if (error) statusCategory = 'error';
      else if (hwCategory === 'experimental') statusCategory = 'experimental';
      else if (hwCategory === 'compatible') statusCategory = 'compatible';
      else statusCategory = 'available';
      out.push({
        id: d.id,
        family: d.family,
        displayName: d.displayName,
        acceleration: d.acceleration,
        capabilities: d.capabilities,
        probedCapabilities: d.family === 'llama.cpp' ? require('./capabilities').summarize(d, caps) : null,
        probedHelpFlags: caps ? caps.helpFlags : null,
        hardware: d.hardware,
        install: d.install,
        defaultPort: d.defaultPort,
        defaultBind: d.defaultBind,
        installed: versions.length > 0 || !!st.customPath,
        versions: versions.map(v => ({ tag: v.tag, label: v.label || v.tag, installedAt: v.installedAt, active: v.tag === st.activeTag })),
        activeTag: st.activeTag || null,
        customPath: st.customPath || null,
        executable,
        version,
        error,
        settings: st.settings || {},
        status: error ? (versions.length ? 'error' : 'not-installed') : 'available',
        statusCategory,
        statusReason: hwCategory === 'experimental'
          ? 'Acceleration runtime not confirmed on this machine — serve attempts may fail with a clear error; CPU-only use is safe.'
          : null
      });
    }
    return out;
  }

  /**
   * Classify acceleration fit for this machine. Never guesses a working
   * state that was not probed.
   */
  _hardwareCategory(d, hardware, caps) {
    if (d.acceleration === 'cpu') return 'compatible';
    if (d.acceleration === 'gpu-vulkan') {
      if (hardware.vulkan === 'available' || hardware.vulkan === 'likely') return 'compatible';
      return 'experimental';
    }
    if (d.acceleration === 'gpu-sycl') {
      if (hardware.sycl === 'runtime-present' || (caps && caps.devices && caps.devices.length)) return 'compatible';
      return 'experimental';
    }
    return 'available';
  }

  /** Run the version probe CLI and parse with the family's static parser. */
  _probe(d, adapter) {
    let exe;
    try { exe = adapter.executablePath(); } catch (_) { return null; }
    try {
      const res = spawnSync(exe, d.versionProbe.args, { timeout: 8000, encoding: 'utf8', windowsHide: true });
      const out = (res.stdout || '') + (res.stderr || '');
      const Cls = require('./adapters').FAMILY_CLASSES[d.family];
      return Cls.parseVersionOutput(out, d.versionProbe.regex);
    } catch (_) {
      return null;
    }
  }

  /** Hardware compatibility detection (best effort, honest about unknowns). */
  hardwareInfo() {
    const os = require('os');
    const info = {
      platform: process.platform,
      arch: os.arch(),
      cpuModel: os.cpus()[0] ? os.cpus()[0].model.trim() : 'unknown',
      cpuCores: os.cpus().length,
      totalMemBytes: os.totalmem(),
      vulkan: 'unknown',
      sycl: 'unknown',
      nvidia: null
    };
    if (process.platform === 'win32') {
      // nvidia-smi detection
      try {
        const r = spawnSync('nvidia-smi', ['--query-gpu=name,memory.total', '--format=csv,noheader'], { timeout: 5000, encoding: 'utf8', windowsHide: true });
        if (r.status === 0 && r.stdout.trim()) {
          const [name, mem] = r.stdout.trim().split(',');
          info.nvidia = { name: name.trim(), vramMB: parseInt((mem || '').replace(/[^\d]/g, ''), 10) || null };
          info.vulkan = 'likely'; // NVIDIA exposes Vulkan
        }
      } catch (_) { /* not present */ }
      // Vulkan: check via a spawned vulkaninfo if available (Vulkan SDK), else unknown
      try {
        const r = spawnSync('vulkaninfo', ['--summary'], { timeout: 5000, encoding: 'utf8', windowsHide: true });
        if (r.status === 0 && /deviceName|GPU/i.test(r.stdout || '')) info.vulkan = 'available';
        else if (r.status !== 0 && /ERROR|not found|Vulkandk/i.test((r.stdout || '') + (r.stderr || ''))) info.vulkan = 'missing';
      } catch (_) { /* vulkaninfo not installed — stays 'unknown' */ }
      // SYCL/Level Zero: look for Level Zero loader in system dirs is unreliable;
      // keep honest 'unknown' unless a device probe succeeds at serve time.
      const fs2 = require('fs');
      const zeLoader = ['ze_loader.dll'].map(f => {
        try {
          for (const sysdir of [process.env.SystemRoot + '\\System32']) {
            if (fs2.existsSync(path.join(sysdir, f))) return true;
          }
        } catch (_) { /* ignore */ }
        return false;
      }).some(Boolean);
      info.sycl = zeLoader ? 'runtime-present' : 'unknown';
    } else {
      // Development platform: report honestly what we know.
      try {
        const r = spawnSync('vulkaninfo', ['--summary'], { timeout: 5000, encoding: 'utf8' });
        if (r.status === 0 && /deviceName/i.test(r.stdout || '')) info.vulkan = 'available';
      } catch (_) { /* ignore */ }
    }
    return info;
  }
}

module.exports = { EngineRegistry, EngineError };
