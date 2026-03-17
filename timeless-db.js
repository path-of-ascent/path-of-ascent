/**
 * Server-side timeless jewel DB query layer.
 * Wraps better-sqlite3 with prepared statements for all timeless jewel operations.
 */
import Database from 'better-sqlite3';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { existsSync } from 'fs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DB_PATH = join(__dirname, 'public', 'data', 'timeless.db');

let db = null;
let stmts = {};

export function initDB() {
  if (db) return;
  if (!existsSync(DB_PATH)) throw new Error(`Timeless DB not found: ${DB_PATH}. Run: node scripts/build-timeless-db.js`);
  db = new Database(DB_PATH, { readonly: true });
  db.pragma('cache_size = -32000'); // 32MB read cache

  stmts = {
    getMetadata: db.prepare('SELECT key, value FROM metadata'),
    getMetaKey: db.prepare('SELECT value FROM metadata WHERE key=?'),
    getJewelInfo: db.prepare('SELECT * FROM timeless_jewel_info'),
    getJewelInfoByType: db.prepare('SELECT * FROM timeless_jewel_info WHERE jewel_type=?'),
    getLutBlob: db.prepare('SELECT seed_data FROM timeless_lut WHERE jewel_type=? AND node_id=?'),
    getLutBlobsForType: db.prepare('SELECT node_id, seed_data FROM timeless_lut WHERE jewel_type=?'),
    getLegionPassive: db.prepare('SELECT * FROM legion_passives WHERE id=?'),
    getLegionPassiveByIdx: db.prepare('SELECT * FROM legion_passives WHERE index_num=? AND type=?'),
    getAllLegionPassives: db.prepare('SELECT * FROM legion_passives'),
    getNotable: db.prepare('SELECT * FROM cluster_notables WHERE name=?'),
    getNotables: db.prepare('SELECT * FROM cluster_notables'),
    getSocket: db.prepare('SELECT * FROM jewel_sockets WHERE node_id=?'),
    getAllSockets: db.prepare('SELECT * FROM jewel_sockets'),
    getTradeIds: db.prepare('SELECT * FROM trade_ids WHERE jewel_type=?'),
    getAllTradeIds: db.prepare('SELECT * FROM trade_ids'),
  };
}

export function getVersion() {
  initDB();
  const rows = stmts.getMetadata.all();
  const meta = {};
  for (const r of rows) meta[r.key] = r.value;
  return meta;
}

export function getJewelInfo(type) {
  initDB();
  return type ? stmts.getJewelInfoByType.get(type) : stmts.getJewelInfo.all();
}

/**
 * Look up a single seed result for a (type, node).
 */
export function lookup(jewelType, nodeId, seed) {
  initDB();
  const info = stmts.getJewelInfoByType.get(jewelType);
  if (!info) return null;
  const row = stmts.getLutBlob.get(jewelType, nodeId);
  if (!row) return null;
  const seedOffset = info.seed_step > 1
    ? Math.floor((seed - info.seed_min) / info.seed_step)
    : (seed - info.seed_min);
  if (seedOffset < 0 || seedOffset >= info.seed_size) return null;
  const resultId = row.seed_data[seedOffset];
  return { resultId, ...resolveResult(resultId) };
}

/**
 * Resolve a result ID to its legion passive data.
 */
function resolveResult(resultId) {
  const ADDITIONS_THRESHOLD = 96;
  if (resultId >= ADDITIONS_THRESHOLD) {
    // Replacement: blob stores globalId. index_num = globalId - 96 + 1
    const idx = resultId - ADDITIONS_THRESHOLD + 1;
    const node = stmts.getLegionPassiveByIdx.get(idx, 'node');
    return {
      isReplacement: true,
      dn: node?.dn || `Node ${resultId}`,
      sd: node ? JSON.parse(node.sd) : [],
      legionId: node?.id || '',
      isKeystone: node?.is_keystone === 1,
    };
  } else {
    // Addition: blob stores globalId which equals index_num directly
    const add = stmts.getLegionPassiveByIdx.get(resultId, 'addition');
    return {
      isReplacement: false,
      dn: add?.dn || `Addition ${resultId}`,
      sd: add ? JSON.parse(add.sd) : [],
      legionId: add?.id || '',
      isKeystone: false,
    };
  }
}

/**
 * Get all transforms for a jewel at a socket with a given seed.
 * nodeIds: array of node IDs in radius to check.
 */
export function getTransforms(jewelType, seed, nodeIds) {
  initDB();
  const info = stmts.getJewelInfoByType.get(jewelType);
  if (!info) return [];
  const seedOffset = info.seed_step > 1
    ? Math.floor((seed - info.seed_min) / info.seed_step)
    : (seed - info.seed_min);
  if (seedOffset < 0 || seedOffset >= info.seed_size) return [];

  const transforms = [];
  for (const nodeId of nodeIds) {
    const row = stmts.getLutBlob.get(jewelType, nodeId);
    if (!row) continue;
    const resultId = row.seed_data[seedOffset];
    transforms.push({ nodeId, resultId, ...resolveResult(resultId) });
  }
  return transforms;
}

/**
 * Search all seeds for best matches against desired mods.
 * desiredMods: [{ legionId, weight }]
 * Returns top seeds sorted by score.
 */
export function searchSeeds(jewelType, nodeIds, desiredMods, opts = {}) {
  initDB();
  const { minScore = 0, maxResults = 100, requiredMods = [] } = opts;
  const info = stmts.getJewelInfoByType.get(jewelType);
  if (!info) return { results: [], timing: 0 };

  // Build legionId → blob byte value lookup
  // Blob stores globalId. For additions: globalId = index_num. For nodes: globalId = index_num + 96 - 1.
  const allPassives = stmts.getAllLegionPassives.all();
  const idToResult = {};
  for (const p of allPassives) {
    idToResult[p.id] = p.type === 'addition' ? p.index_num : p.index_num + 96 - 1;
  }
  const desiredResultIds = new Map(); // resultId → { weight, legionId }
  for (const mod of desiredMods) {
    const resultId = idToResult[mod.legionId];
    if (resultId !== undefined) {
      desiredResultIds.set(resultId, { weight: mod.weight || 1, legionId: mod.legionId });
    }
  }
  const requiredResultIds = new Set();
  for (const reqId of requiredMods) {
    const resultId = idToResult[reqId];
    if (resultId !== undefined) requiredResultIds.add(resultId);
  }

  // Load blobs for relevant nodes
  const blobs = [];
  for (const nodeId of nodeIds) {
    const row = stmts.getLutBlob.get(jewelType, nodeId);
    if (row) blobs.push({ nodeId, data: row.seed_data });
  }

  const start = performance.now();
  const scores = new Float32Array(info.seed_size);
  const matchData = new Array(info.seed_size); // sparse, only populated for top results

  // Score all seeds
  for (const { nodeId, data } of blobs) {
    for (let s = 0; s < info.seed_size; s++) {
      const resultId = data[s];
      const desired = desiredResultIds.get(resultId);
      if (desired) scores[s] += desired.weight;
    }
  }

  // Filter and rank
  const results = [];
  for (let s = 0; s < info.seed_size; s++) {
    if (scores[s] < minScore) continue;
    const seed = info.seed_step > 1 ? info.seed_min + s * info.seed_step : info.seed_min + s;

    // Check required mods
    if (requiredResultIds.size > 0) {
      const foundReq = new Set();
      for (const { data } of blobs) {
        if (requiredResultIds.has(data[s])) foundReq.add(data[s]);
      }
      if (foundReq.size < requiredResultIds.size) continue;
    }

    results.push({ seed, score: scores[s] });
  }

  results.sort((a, b) => b.score - a.score);
  const topResults = results.slice(0, maxResults);

  // Enrich top results with match details
  for (const result of topResults) {
    const seedOffset = info.seed_step > 1
      ? Math.floor((result.seed - info.seed_min) / info.seed_step)
      : (result.seed - info.seed_min);
    result.matches = [];
    for (const { nodeId, data } of blobs) {
      const resultId = data[seedOffset];
      const desired = desiredResultIds.get(resultId);
      if (desired) {
        const resolved = resolveResult(resultId);
        result.matches.push({ nodeId, ...desired, ...resolved });
      }
    }
  }

  const timing = Math.round(performance.now() - start);
  return { results: topResults, timing, totalSeeds: info.seed_size, matchingSeeds: results.length };
}

/**
 * Find seeds similar to a given seed (same transforms on shared nodes).
 */
export function findSimilarSeeds(jewelType, referenceSeed, nodeIds, opts = {}) {
  initDB();
  const { minMatch = 1, maxResults = 50 } = opts;
  const info = stmts.getJewelInfoByType.get(jewelType);
  if (!info) return { results: [], timing: 0 };

  const refOffset = info.seed_step > 1
    ? Math.floor((referenceSeed - info.seed_min) / info.seed_step)
    : (referenceSeed - info.seed_min);
  if (refOffset < 0 || refOffset >= info.seed_size) return { results: [], timing: 0 };

  // Load blobs and get reference results
  const nodeBlobs = [];
  const refResults = {};
  for (const nodeId of nodeIds) {
    const row = stmts.getLutBlob.get(jewelType, nodeId);
    if (!row) continue;
    const refResultId = row.seed_data[refOffset];
    refResults[nodeId] = refResultId;
    nodeBlobs.push({ nodeId, data: row.seed_data, refResultId });
  }

  const start = performance.now();
  const matchCounts = new Uint16Array(info.seed_size);

  for (const { data, refResultId } of nodeBlobs) {
    for (let s = 0; s < info.seed_size; s++) {
      if (data[s] === refResultId) matchCounts[s]++;
    }
  }

  const results = [];
  for (let s = 0; s < info.seed_size; s++) {
    if (matchCounts[s] < minMatch) continue;
    const seed = info.seed_step > 1 ? info.seed_min + s * info.seed_step : info.seed_min + s;
    if (seed === referenceSeed) continue;
    results.push({ seed, matchCount: matchCounts[s], totalNodes: nodeBlobs.length });
  }

  results.sort((a, b) => b.matchCount - a.matchCount);
  const topResults = results.slice(0, maxResults);

  // Enrich with diff details
  for (const result of topResults) {
    const seedOffset = info.seed_step > 1
      ? Math.floor((result.seed - info.seed_min) / info.seed_step)
      : (result.seed - info.seed_min);
    result.diff = [];
    for (const { nodeId, data, refResultId } of nodeBlobs) {
      const altResultId = data[seedOffset];
      const same = altResultId === refResultId;
      result.diff.push({
        nodeId, same,
        original: resolveResult(refResultId),
        alternative: same ? null : resolveResult(altResultId),
      });
    }
  }

  const timing = Math.round(performance.now() - start);
  return { results: topResults, timing, referenceResults: refResults };
}

/**
 * Get notable stats from cluster_notables table.
 */
export function getNotableStats(name) {
  initDB();
  const row = stmts.getNotable.get(name);
  if (!row) return null;
  return { name: row.name, nodeId: row.node_id, stats: JSON.parse(row.stats) };
}

/**
 * Get all notables (for batch operations).
 */
export function getAllNotables() {
  initDB();
  return stmts.getNotables.all().map(r => ({ ...r, stats: JSON.parse(r.stats) }));
}

/**
 * Get socket info by node ID.
 */
export function getSocketInfo(nodeId) {
  initDB();
  return stmts.getSocket.get(nodeId);
}

export function getAllSockets() {
  initDB();
  return stmts.getAllSockets.all();
}

export function getAllLegionPassives() {
  initDB();
  return stmts.getAllLegionPassives.all().map(r => ({
    ...r, sd: JSON.parse(r.sd), stats: r.stats ? JSON.parse(r.stats) : null,
  }));
}

/**
 * Generate PoB item text for a timeless jewel (matches TimelessJewelListControl.lua format).
 * jewelType: 1-6, seed: number, conquerorIdx: 0-2, keystoneName: string (optional)
 */
export function generateJewelText(jewelType, seed, conquerorIdx, keystoneName = '') {
  const variant = conquerorIdx === 0 ? 1 : conquerorIdx;
  const label = `[${seed}; 0; ${keystoneName}]\n`;

  const templates = {
    1: { // Glorious Vanity
      name: 'Glorious Vanity',
      variants: ['Doryani (Corrupted Soul)', 'Xibaqua (Divine Flesh)', 'Ahuana (Immortal Ambition)'],
      flavors: [
        `Bathed in the blood of ${seed} sacrificed in the name of Doryani`,
        `Bathed in the blood of ${seed} sacrificed in the name of Xibaqua`,
        `Bathed in the blood of ${seed} sacrificed in the name of Ahuana`,
      ],
      conquered: 'Passives in radius are Conquered by the Vaal',
    },
    2: { // Lethal Pride
      name: 'Lethal Pride',
      variants: ['Kaom (Strength of Blood)', 'Rakiata (Tempered by War)', 'Akoya (Chainbreaker)'],
      flavors: [
        `Commanded leadership over ${seed} warriors under Kaom`,
        `Commanded leadership over ${seed} warriors under Rakiata`,
        `Commanded leadership over ${seed} warriors under Akoya`,
      ],
      conquered: 'Passives in radius are Conquered by the Karui',
    },
    3: { // Brutal Restraint
      name: 'Brutal Restraint',
      variants: ['Asenath (Dance with Death)', 'Nasima (Second Sight)', 'Balbala (The Traitor)'],
      flavors: [
        `Denoted service of ${seed} dekhara in the akhara of Asenath`,
        `Denoted service of ${seed} dekhara in the akhara of Nasima`,
        `Denoted service of ${seed} dekhara in the akhara of Balbala`,
      ],
      conquered: 'Passives in radius are Conquered by the Maraketh',
    },
    4: { // Militant Faith
      name: 'Militant Faith',
      variants: ['Avarius (Power of Purpose)', 'Dominus (Inner Conviction)', 'Maxarius (Transcendence)'],
      flavors: [
        `Carved to glorify ${seed} new faithful converted by High Templar Avarius`,
        `Carved to glorify ${seed} new faithful converted by High Templar Dominus`,
        `Carved to glorify ${seed} new faithful converted by High Templar Maxarius`,
      ],
      conquered: 'Passives in radius are Conquered by the Templars',
      extraVariants: [
        'Totem Damage', 'Brand Damage', 'Channelling Damage', 'Area Damage',
        'Elemental Damage', 'Elemental Resistances', 'Effect of non-Damaging Ailments',
        'Elemental Ailment Duration', 'Duration of Curses', 'Minion Attack and Cast Speed',
        'Minions Accuracy Rating', 'Mana Regen', 'Skill Cost', 'Non-Curse Aura Effect',
        'Defences from Shield',
      ],
      extraMods: [
        '4% increased Totem Damage per 10 Devotion',
        '4% increased Brand Damage per 10 Devotion',
        'Channelling Skills deal 4% increased Damage per 10 Devotion',
        '4% increased Area Damage per 10 Devotion',
        '4% increased Elemental Damage per 10 Devotion',
        '+2% to all Elemental Resistances per 10 Devotion',
        '3% increased Effect of non-Damaging Ailments on Enemies per 10 Devotion',
        '4% reduced Elemental Ailment Duration on you per 10 Devotion',
        '4% reduced Duration of Curses on you per 10 Devotion',
        '1% increased Minion Attack and Cast Speed per 10 Devotion',
        'Minions have +60 to Accuracy Rating per 10 Devotion',
        'Regenerate 0.6 Mana per Second per 10 Devotion',
        '1% reduced Mana Cost of Skills per 10 Devotion',
        '1% increased effect of Non-Curse Auras per 10 Devotion',
        '3% increased Defences from Equipped Shield per 10 Devotion',
      ],
    },
    5: { // Elegant Hubris
      name: 'Elegant Hubris',
      variants: ['Cadiro (Supreme Decadence)', 'Victario (Supreme Grandstanding)', 'Caspiro (Supreme Ostentation)'],
      flavors: [
        `Commissioned ${seed} coins to commemorate Cadiro`,
        `Commissioned ${seed} coins to commemorate Victario`,
        `Commissioned ${seed} coins to commemorate Caspiro`,
      ],
      conquered: 'Passives in radius are Conquered by the Eternal Empire',
    },
    6: { // Heroic Tragedy
      name: 'Heroic Tragedy',
      variants: ['Vorana (Black Scythe Training)', 'Uhtred (Celestial Mathematics)', 'Medved (The Unbreaking Circle)'],
      flavors: [
        `Remembrancing ${seed} songworthy deeds by the line of Vorana`,
        `Remembrancing ${seed} songworthy deeds by the line of Uhtred`,
        `Remembrancing ${seed} songworthy deeds by the line of Medved`,
      ],
      conquered: 'Passives in radius are Conquered by the Kalguur',
    },
  };

  const t = templates[jewelType];
  if (!t) return null;

  let lines = [`${t.name} ${label}Timeless Jewel`, 'League: Legion', 'Limited to: 1 Historic'];

  if (jewelType === 4) {
    lines.push('Has Alt Variant: true', 'Has Alt Variant Two: true');
  }

  for (const v of t.variants) lines.push(`Variant: ${v}`);
  if (t.extraVariants) for (const v of t.extraVariants) lines.push(`Variant: ${v}`);

  lines.push(`Selected Variant: ${variant}`);
  if (jewelType === 4) {
    lines.push('Selected Alt Variant: 4', 'Selected Alt Variant Two: 5');
  }

  lines.push('Radius: Large', 'Implicits: 0');
  for (let i = 0; i < t.flavors.length; i++) lines.push(`{variant:${i + 1}}${t.flavors[i]}`);
  if (t.extraMods) {
    for (let i = 0; i < t.extraMods.length; i++) lines.push(`{variant:${i + 4}}${t.extraMods[i]}`);
  }
  lines.push(t.conquered, 'Historic');

  return lines.join('\n');
}

export function getTradeIds(jewelType) {
  initDB();
  const rows = jewelType ? stmts.getTradeIds.all(jewelType) : stmts.getAllTradeIds.all();
  const result = {};
  for (const r of rows) {
    if (!result[r.jewel_type]) result[r.jewel_type] = {};
    if (!result[r.jewel_type][r.category]) result[r.jewel_type][r.category] = [];
    result[r.jewel_type][r.category][r.conqueror_idx] = r.stat_id;
  }
  return result;
}
