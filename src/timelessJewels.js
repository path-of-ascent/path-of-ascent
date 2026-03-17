/**
 * Timeless Jewel client module.
 * All heavy computation happens server-side via /api/timeless/* endpoints.
 * This module handles item parsing, API calls, and trade URL generation.
 */

// --- Jewel type constants (for client-side parsing, no LUT needed) ---

export const JEWEL_TYPES = {
  'Glorious Vanity':  { type: 1, conquerors: ['Doryani', 'Xibaqua', 'Ahuana'], flavorPattern: /(?:Bathed in the blood of)\s+(\d+)\s+sacrificed/i },
  'Lethal Pride':     { type: 2, conquerors: ['Kaom', 'Rakiata', 'Akoya'], flavorPattern: /(?:Commanded leadership over|under)\s+(\d+)\s+warriors/i },
  'Brutal Restraint': { type: 3, conquerors: ['Asenath', 'Nasima', 'Balbala'], flavorPattern: /(?:Denoted service of)\s+(\d+)\s+dekhara/i },
  'Militant Faith':   { type: 4, conquerors: ['Avarius', 'Dominus', 'Maxarius'], flavorPattern: /(?:Carved to glorify)\s+(\d+)\s+new faithful/i },
  'Elegant Hubris':   { type: 5, conquerors: ['Cadiro', 'Victario', 'Caspiro'], flavorPattern: /(?:Commissioned)\s+(\d+)\s+coins/i },
  'Heroic Tragedy':   { type: 6, conquerors: ['Vorana', 'Uhtred', 'Medved'], flavorPattern: /(?:Tells the saga of)\s+(\d+)\s+battles/i },
};

// Module-level caches
let _cachedPassives = null;
let _cachedSockets = null;
let _cachedTradeIds = null;

/**
 * Parse a timeless jewel from its PoB item data.
 */
export function parseTimelessJewel(item) {
  const raw = item.raw || '';
  const name = item.name || '';

  for (const [jewelName, info] of Object.entries(JEWEL_TYPES)) {
    if (!name.includes(jewelName) && !raw.includes(jewelName)) continue;
    const seedMatch = raw.match(info.flavorPattern);
    if (!seedMatch) continue;
    const seed = parseInt(seedMatch[1]);
    for (let ci = 0; ci < info.conquerors.length; ci++) {
      if (raw.includes(info.conquerors[ci])) {
        return { jewelName, ...info, seed, conquerorIdx: ci, conquerorName: info.conquerors[ci] };
      }
    }
    return { jewelName, ...info, seed, conquerorIdx: 0, conquerorName: info.conquerors[0] };
  }
  return null;
}

// --- API calls ---

async function apiFetch(path, opts) {
  const resp = opts?.body
    ? await fetch(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(opts.body) })
    : await fetch(path);
  if (!resp.ok) throw new Error(`API error ${resp.status}: ${path}`);
  return resp.json();
}

/** Get DB version/metadata */
export async function getDBVersion() {
  return apiFetch('/api/timeless/version');
}

/** Get all legion passives (additions + nodes). Cached. */
export async function getLegionPassives() {
  if (_cachedPassives) return _cachedPassives;
  _cachedPassives = await apiFetch('/api/timeless/passives');
  return _cachedPassives;
}

/** Get all jewel sockets with keystone names. Cached. */
export async function getJewelSockets() {
  if (_cachedSockets) return _cachedSockets;
  _cachedSockets = await apiFetch('/api/timeless/sockets');
  return _cachedSockets;
}

/** Get trade IDs. Cached. */
export async function getTradeIds() {
  if (_cachedTradeIds) return _cachedTradeIds;
  _cachedTradeIds = await apiFetch('/api/timeless/trade-ids');
  return _cachedTradeIds;
}

/** Get transforms for a jewel at a socket. */
export async function getTransforms(jewelType, seed, nodeIds) {
  return apiFetch('/api/timeless/transforms', { body: { jewelType, seed, nodeIds } });
}

/** Search seeds. Returns { results, timing, totalSeeds, matchingSeeds }. */
export async function searchSeeds(jewelType, nodeIds, desiredMods, opts = {}) {
  return apiFetch('/api/timeless/search', { body: { jewelType, nodeIds, desiredMods, ...opts } });
}

/** Find seeds similar to a reference seed. */
export async function findSimilarSeeds(jewelType, referenceSeed, nodeIds, opts = {}) {
  return apiFetch('/api/timeless/similar', { body: { jewelType, referenceSeed, nodeIds, ...opts } });
}

/** DPS/EHP-weighted timeless jewel search via PoB calc engine. */
export async function searchSeedsByDPS(pobCode, sockets, opts = {}) {
  return apiFetch('/api/timeless/search-dps', {
    body: { pobCode, sockets, ...opts },
  });
}

/** Get notable stats by name. */
export async function getNotableStats(name) {
  return apiFetch(`/api/timeless/notable?name=${encodeURIComponent(name)}`);
}

/** Get jewel info (seed ranges etc). */
export async function getJewelInfo(type) {
  return apiFetch(`/api/timeless/jewel-info${type ? `?type=${type}` : ''}`);
}

// --- Radius calculation (still client-side, needs tree positions) ---

const LARGE_RADIUS = 1800;

export function getNodesInRadius(socketNodeId, positions, treeNodes, radius = LARGE_RADIUS) {
  const socketPos = positions[socketNodeId];
  if (!socketPos) return [];
  const r2 = radius * radius;
  const result = [];

  for (const [nodeId, pos] of Object.entries(positions)) {
    const node = treeNodes[nodeId];
    if (!node) continue;
    if (node.isJewelSocket || node.isMastery || node.ascendancyName) continue;
    if (nodeId === socketNodeId) continue;

    const dx = pos.x - socketPos.x;
    const dy = pos.y - socketPos.y;
    if (dx * dx + dy * dy > r2) continue;

    result.push({
      nodeId,
      name: node.name || nodeId,
      isNotable: !!node.isNotable,
      isKeystone: !!node.isKeystone,
    });
  }
  return result;
}

// --- Trade URL generation ---

export function buildTradeUrl(league, jewelType, conquerorIdx, seeds, tradeIds) {
  const typeKey = String(jewelType);
  const tradeInfo = tradeIds[typeKey];
  if (!tradeInfo?.keystone) return null;

  const filters = [];
  for (const seed of seeds) {
    if (conquerorIdx >= 0 && conquerorIdx < tradeInfo.keystone.length) {
      filters.push({ id: tradeInfo.keystone[conquerorIdx], value: { min: seed, max: seed } });
    } else {
      for (const ksId of tradeInfo.keystone) filters.push({ id: ksId, value: { min: seed, max: seed } });
    }
  }

  const query = {
    query: { status: { option: 'online' }, stats: [{ filters, type: 'count', value: { min: 1 } }] },
    sort: { price: 'asc' },
  };
  return `https://www.pathofexile.com/trade/search/${league}/?q=${encodeURIComponent(JSON.stringify(query))}`;
}

/**
 * Get available mods for the search mod picker.
 */
export function getAvailableMods(passives) {
  const mods = [];
  for (const p of passives) {
    if (p.is_keystone) continue;
    mods.push({ id: p.id, dn: p.dn, sd: p.sd, type: p.type });
  }
  return mods;
}
