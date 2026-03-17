/**
 * PoB Headless Bridge — manages a long-lived LuaJIT child process
 * that runs Path of Building's calc engine via stdin/stdout JSON-RPC.
 */
import { spawn } from 'child_process';
import { createInterface } from 'readline';
import { createHash } from 'crypto';
import { inflate } from 'pako';

const POB_DIR = process.env.POB_DIR || '/home/mike/projects/PathOfBuilding';
const LUAJIT = process.env.LUAJIT || 'luajit';
const TIMEOUT_MS = 60000; // 60s — weight calc can be slow

class PoBBridge {
  constructor() {
    this.proc = null;
    this.rl = null;
    this.ready = false;
    this.pending = null; // { resolve, reject, timer }
    this.queue = [];     // queued requests
    this.cache = new Map(); // hash → { result, ts }
    this.cacheTTL = 300000; // 5 min
    this.loadedBuildHash = null; // hash of currently loaded PoB XML
  }

  async start() {
    if (this.proc) return;

    return new Promise((resolve, reject) => {
      const env = {
        ...process.env,
        POB_API_STDIO: '1',
      };

      this.proc = spawn(LUAJIT, ['HeadlessWrapper.lua', '--stdio'], {
        cwd: POB_DIR + '/src',
        env,
        stdio: ['pipe', 'pipe', 'pipe'],
      });

      this.proc.stderr.on('data', (chunk) => {
        const msg = chunk.toString().trim();
        if (msg) console.error('[PoB stderr]', msg);
      });

      this.proc.on('error', (err) => {
        console.error('[PoB] spawn error:', err.message);
        this.cleanup();
        reject(err);
      });

      this.proc.on('exit', (code, signal) => {
        console.log(`[PoB] exited: code=${code} signal=${signal}`);
        this.cleanup();
      });

      this.rl = createInterface({ input: this.proc.stdout });

      // Wait for ready banner
      const bannerTimeout = setTimeout(() => {
        reject(new Error('PoB startup timed out'));
        this.stop();
      }, 30000);

      const onLine = (line) => {
        if (!line.trim() || !line.trim().startsWith('{')) return;
        try {
          const msg = JSON.parse(line);
          if (msg.ready) {
            clearTimeout(bannerTimeout);
            this.ready = true;
            console.log('[PoB] ready:', JSON.stringify(msg.version || {}));
            // Switch to normal line handler
            this.rl.removeListener('line', onLine);
            this.rl.on('line', (l) => this._onLine(l));
            resolve();
          }
        } catch {}
      };
      this.rl.on('line', onLine);
    });
  }

  _onLine(line) {
    if (!line.trim() || !line.trim().startsWith('{')) return;
    if (!this.pending) return;
    try {
      const res = JSON.parse(line);
      clearTimeout(this.pending.timer);
      this.pending.resolve(res);
      this.pending = null;
      this._processQueue();
    } catch (e) {
      // not JSON, skip
    }
  }

  _processQueue() {
    if (this.pending || this.queue.length === 0) return;
    const next = this.queue.shift();
    this._sendRaw(next.action, next.params, next.resolve, next.reject);
  }

  _sendRaw(action, params, resolve, reject) {
    if (!this.proc || !this.ready) {
      return reject(new Error('PoB not running'));
    }
    const timer = setTimeout(() => {
      this.pending = null;
      reject(new Error(`PoB timeout on ${action}`));
    }, TIMEOUT_MS);

    this.pending = { resolve, reject, timer };
    const msg = JSON.stringify({ action, params }) + '\n';
    this.proc.stdin.write(msg);
  }

  send(action, params = {}) {
    return new Promise((resolve, reject) => {
      if (this.pending) {
        this.queue.push({ action, params, resolve, reject });
      } else {
        this._sendRaw(action, params, resolve, reject);
      }
    });
  }

  cleanup() {
    this.ready = false;
    this.proc = null;
    this.loadedBuildHash = null;
    if (this.pending) {
      clearTimeout(this.pending.timer);
      this.pending.reject(new Error('PoB process exited'));
      this.pending = null;
    }
    for (const q of this.queue) {
      q.reject(new Error('PoB process exited'));
    }
    this.queue = [];
  }

  async stop() {
    if (!this.proc) return;
    try {
      await this.send('quit').catch(() => {});
    } catch {}
    if (this.proc) {
      this.proc.kill();
      this.proc = null;
    }
    this.cleanup();
  }

  async ensureRunning() {
    if (!this.proc || !this.ready) {
      console.log('[PoB] starting headless engine...');
      await this.start();
    }
  }

  /**
   * Decode a PoB paste code into XML.
   * PoB codes are base64(zlib(xml)).
   */
  decodePobCode(code) {
    // Clean up the code
    code = code.trim().replace(/\s+/g, '');
    // URL-safe base64 → standard
    const b64 = code.replace(/-/g, '+').replace(/_/g, '/');
    const raw = Buffer.from(b64, 'base64');
    // Inflate
    const xml = inflate(raw, { to: 'string' });
    return xml;
  }

  /**
   * Load a build from PoB paste code.
   * Skips reload if the same build is already loaded.
   */
  async loadBuild(pobCode) {
    await this.ensureRunning();
    const buildHash = createHash('md5').update(pobCode).digest('hex');
    if (this.loadedBuildHash === buildHash) {
      return { ok: true, cached: true };
    }
    const xml = this.decodePobCode(pobCode);
    const res = await this.send('load_build_xml', { xml, name: 'Trade Weight Calc' });
    if (!res.ok) throw new Error(res.error || 'load_build_xml failed');
    this.loadedBuildHash = buildHash;
    return res;
  }

  /**
   * Get current build stats.
   */
  async getStats(fields) {
    await this.ensureRunning();
    const res = await this.send('get_stats', { fields });
    if (!res.ok) throw new Error(res.error || 'get_stats failed');
    return res.stats;
  }

  /**
   * Calculate mod weights for an item's stat lines.
   * Returns weight data for each mod showing DPS/EHP impact.
   */
  async calcModWeights(slotName, modLines) {
    await this.ensureRunning();
    const res = await this.send('calc_mod_weights', { slotName, modLines });
    if (!res.ok) throw new Error(res.error || 'calc_mod_weights failed');
    return res.result;
  }

  /**
   * Full weight calculation with caching.
   * pobCode: base64 PoB paste
   * slotName: "Body Armour", "Helmet", etc.
   * modLines: array of mod text strings to weight
   */
  async getWeights(pobCode, slotName, modLines) {
    // Cache key includes build hash + slot + mods
    const buildHash = createHash('md5').update(pobCode).digest('hex');
    const cacheKey = buildHash + '|' + slotName + '|' + modLines.join('|');
    const cached = this.cache.get(cacheKey);
    if (cached && Date.now() - cached.ts < this.cacheTTL) {
      return cached.result;
    }

    // Load build (skips if same build already loaded) and calc
    await this.loadBuild(pobCode);
    const result = await this.calcModWeights(slotName, modLines);

    // Cache result
    this.cache.set(cacheKey, { result, ts: Date.now() });

    // Evict old cache entries
    if (this.cache.size > 50) {
      const now = Date.now();
      for (const [k, v] of this.cache) {
        if (now - v.ts > this.cacheTTL) this.cache.delete(k);
      }
    }

    return result;
  }

  /**
   * Batch weight calc — all slots in one call.
   * slots: [{ slotName, modLines }, ...]
   * Returns { slotName: { weights, totalScore, guideScore, ... } }
   */
  async compareSlots(pobCode, slots) {
    await this.loadBuild(pobCode);
    const res = await this.send('calc_mod_weights_batch', { slots });
    if (!res.ok) throw new Error(res.error || 'batch calc failed');
    return res.result;
  }

  // --- Upgrade Planner bridge methods ---

  async getStats(fields) {
    await this.ensureRunning();
    const res = await this.send('get_stats', { fields });
    if (!res.ok) throw new Error(res.error || 'get_stats failed');
    return res;
  }

  async setTree(params) {
    await this.ensureRunning();
    return this.send('set_tree', params);
  }

  async calcWith(params) {
    await this.ensureRunning();
    return this.send('calc_with', params);
  }

  async addItemText(text, slotName) {
    await this.ensureRunning();
    return this.send('add_item_text', { text, slotName });
  }

  async updateTreeDelta(params) {
    await this.ensureRunning();
    return this.send('update_tree_delta', params);
  }

  async getSkillsInfo() {
    await this.ensureRunning();
    return this.send('get_skills', {});
  }

  async createSocketGroup(params) {
    await this.ensureRunning();
    return this.send('create_socket_group', params);
  }

  async addGem(params) {
    await this.ensureRunning();
    return this.send('add_gem', params);
  }

  async removeGem(params) {
    await this.ensureRunning();
    return this.send('remove_gem', params);
  }

  async removeSkill(params) {
    await this.ensureRunning();
    return this.send('remove_skill', params);
  }

  async exportBuildXml() {
    await this.ensureRunning();
    return this.send('export_build_xml', {});
  }

  /**
   * Batch evaluate timeless jewel candidates in a slot.
   * slotName: "Jewel 26725"
   * jewelTexts: array of PoB item text strings
   * Returns array of { dps, ehp, fullDps, combinedDps, totalEhp, life, es }
   */
  async calcTimelessBatch(slotName, jewelTexts) {
    await this.ensureRunning();
    const res = await this.send('calc_timeless_batch', { slotName, jewelTexts });
    if (!res.ok) throw new Error(res.error || 'calc_timeless_batch failed');
    return res.results;
  }
}

// Singleton
const bridge = new PoBBridge();

export default bridge;
export { PoBBridge };
