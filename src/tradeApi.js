import { tradeFetch } from './api';

const TRADE_API = '/api/trade';
const TRADE_SITE = 'https://www.pathofexile.com/trade';
const RATE_LIMIT_DELAY = 1500; // 1.5s between requests (safe margin over GGG's 1/sec)

// Proper sequential queue — only one request at a time, guaranteed delay between them
let requestQueue = Promise.resolve();
let lastRequestTime = 0;

async function rateLimitedFetch(url, options) {
  // Chain onto the queue so requests are strictly sequential
  const result = requestQueue.then(async () => {
    const now = Date.now();
    const elapsed = now - lastRequestTime;
    if (elapsed < RATE_LIMIT_DELAY) {
      await new Promise(r => setTimeout(r, RATE_LIMIT_DELAY - elapsed));
    }
    lastRequestTime = Date.now();
    const res = await tradeFetch(url, options);
    // If 429, wait and retry once
    if (res.status === 429) {
      const retryAfter = parseInt(res.headers.get('Retry-After') || '10', 10);
      console.warn(`[Trade] 429 rate limited, waiting ${retryAfter}s...`);
      await new Promise(r => setTimeout(r, (retryAfter + 2) * 1000));
      lastRequestTime = Date.now();
      return tradeFetch(url, options);
    }
    return res;
  });
  // Update queue head (don't let errors break the chain)
  requestQueue = result.catch(() => {});
  return result;
}

// Singleton promises for data loading (prevents race conditions)
let baseTypesPromise = null;
let statLookupPromise = null;
let validBaseTypes = null;
let statLookup = null;

async function loadBaseTypes() {
  if (validBaseTypes) return validBaseTypes;
  if (baseTypesPromise) return baseTypesPromise;
  baseTypesPromise = (async () => {
    try {
      const res = await rateLimitedFetch(`${TRADE_API}/data/items`);
      if (!res.ok) return new Set();
      const data = await res.json();
      const types = new Set();
      for (const cat of data.result) {
        for (const entry of cat.entries) {
          if (entry.type) types.add(entry.type);
          if (entry.name) types.add(entry.name);
        }
      }
      validBaseTypes = types;
      return types;
    } catch {
      baseTypesPromise = null; // Allow retry on failure
      return new Set();
    }
  })();
  return baseTypesPromise;
}

/**
 * Load ALL stat data from trade API into a comprehensive lookup.
 * Key insight from Awakened PoE Trade: exact string matching only,
 * with all possible # placeholder patterns pre-indexed.
 */
async function loadStatLookup() {
  if (statLookup) return statLookup;
  if (statLookupPromise) return statLookupPromise;
  statLookupPromise = (async () => {
  const _statLookup = new Map();
  try {
    const res = await rateLimitedFetch(`${TRADE_API}/data/stats`);
    if (!res.ok) { statLookupPromise = null; return _statLookup; }
    const data = await res.json();

    const priority = { pseudo: 0, explicit: 1, implicit: 2, crafted: 3, enchant: 4, fractured: 5 };

    for (const group of data.result) {
      for (const entry of group.entries) {
        if (!entry.id || !entry.text) continue;

        const normalized = entry.text.replace(/\n/g, ' ').trim().toLowerCase();
        const prefix = entry.id.split('.')[0];
        const prio = priority[prefix] ?? 6;

        const existing = _statLookup.get(normalized);
        if (!existing || prio < existing.prio) {
          _statLookup.set(normalized, { id: entry.id, prio, type: prefix });
        }

        if (entry.text.includes('\n')) {
          const lines = entry.text.split('\n').map(l => l.trim()).filter(l => l);
          for (const line of lines) {
            const lineNorm = line.replace(/\n/g, ' ').trim().toLowerCase();
            const lineKey = `__multiline:${lineNorm}`;
            const existing2 = _statLookup.get(lineKey);
            if (!existing2 || prio < existing2.prio) {
              _statLookup.set(lineKey, { id: entry.id, prio, type: prefix, fullText: normalized });
            }
          }
        }

        if (normalized.includes('(#-#)')) {
          const alt = normalized.replace(/\(#-#\)/g, '# to #');
          const ex2 = _statLookup.get(alt);
          if (!ex2 || prio < ex2.prio) {
            _statLookup.set(alt, { id: entry.id, prio, type: prefix });
          }
        }
        if (normalized.includes('# to #') && !normalized.includes('(#-#)')) {
          const alt = normalized.replace(/# to #/g, '(#-#)');
          const ex2 = _statLookup.get(alt);
          if (!ex2 || prio < ex2.prio) {
            _statLookup.set(alt, { id: entry.id, prio, type: prefix });
          }
        }
      }
    }
    console.log(`Loaded ${_statLookup.size} stat patterns from trade API`);
    statLookup = _statLookup;
    return statLookup;
  } catch {
    statLookupPromise = null; // Allow retry on failure
    return _statLookup;
  }
  })();
  return statLookupPromise;
}

/**
 * Generate all combinatorial # substitution patterns for a line.
 * Awakened PoE Trade approach: try replacing each number with # independently.
 * For N numbers, generates 2^N combinations (all # first, then selective).
 */
function generatePlaceholderCombinations(line) {
  const numberRegex = /-?\d+(\.\d+)?/g;
  const matches = [];
  let m;
  while ((m = numberRegex.exec(line)) !== null) {
    matches.push({ start: m.index, end: m.index + m[0].length, value: m[0] });
  }
  if (matches.length === 0) return [];

  const results = [];
  const count = matches.length;
  // Limit combinatorial explosion: max 5 numbers = 32 combos
  const maxCombos = Math.min(1 << count, 32);

  for (let mask = 0; mask < maxCombos; mask++) {
    let result = '';
    let lastEnd = 0;
    let anyReplaced = false;
    for (let i = 0; i < count; i++) {
      result += line.substring(lastEnd, matches[i].start);
      if (mask & (1 << i)) {
        // Keep original number
        result += matches[i].value;
      } else {
        // Replace with #
        result += '#';
        anyReplaced = true;
      }
      lastEnd = matches[i].end;
    }
    result += line.substring(lastEnd);
    if (anyReplaced) {
      results.push({ pattern: result, numbers: matches.map(m => parseFloat(m.value)) });
    }
  }

  // Sort: all-# first (mask=0), then by number of # replacements (descending)
  results.sort((a, b) => {
    const aCount = (a.pattern.match(/#/g) || []).length;
    const bCount = (b.pattern.match(/#/g) || []).length;
    return bCount - aCount; // More #'s first
  });

  return results;
}

/**
 * Detect modifier type from PoB mod line tags/suffixes.
 * PoB uses {exarch}, {eater}, {crafted} tag prefixes and/or
 * (implicit), (crafted), (enchant), (fractured) suffixes.
 */
function detectModType(line) {
  // Tag-based detection (PoB Community Fork format)
  if (/\{exarch\}/i.test(line)) return 'implicit';
  if (/\{eater\}/i.test(line)) return 'implicit';
  if (/\{crafted\}/i.test(line)) return 'crafted';
  // Suffix-based detection (legacy/export format)
  if (/ \(implicit\)$/i.test(line)) return 'implicit';
  if (/ \(Searing Exarch\)$/i.test(line)) return 'implicit';
  if (/ \(Eater of Worlds\)$/i.test(line)) return 'implicit';
  if (/ \(crafted\)$/i.test(line)) return 'crafted';
  if (/ \(enchant\)$/i.test(line)) return 'enchant';
  if (/ \(fractured\)$/i.test(line)) return 'fractured';
  return 'explicit'; // default
}

/**
 * Match a mod line to a trade API stat ID using combinatorial placeholder substitution.
 * Returns { id, value, modType } or null.
 */
function matchModToStat(line, lookup) {
  const modType = detectModType(line);
  // Strip both {tag} prefixes and (suffix) annotations
  const cleanLine = line.replace(/\{[^}]*\}/g, '').replace(/ \(enchant\)| \(implicit\)| \(crafted\)| \(fractured\)| \(Searing Exarch\)| \(Eater of Worlds\)/gi, '').trim();

  // Extract all numbers for value calculation
  const allNumbers = cleanLine.match(/-?\d+(\.\d+)?/g);
  if (!allNumbers) {
    // Some stats have no numbers (e.g., "Cannot be Frozen")
    const noNumPattern = cleanLine.toLowerCase();
    const entry = lookup.get(noNumPattern);
    if (entry) return { id: entry.id, value: {}, modType };
    return null;
  }

  // Generate all # placeholder combinations and try each
  const combos = generatePlaceholderCombinations(cleanLine);
  for (const { pattern } of combos) {
    const patLower = pattern.toLowerCase();

    // Direct lookup
    let entry = lookup.get(patLower);
    if (entry) {
      // If we found a type-specific match, prefer it
      if (entry.type === modType || entry.type === 'pseudo') {
        return buildResult(entry.id, allNumbers, pattern, modType);
      }
      // Store as fallback, keep looking for type-specific
      let fallback = entry;
      // Check if there's a type-specific variant in the lookup
      // (pseudo IDs are always preferred over type-specific)
      return buildResult(fallback.id, allNumbers, pattern, modType);
    }

    // Try "Adds X to Y" ↔ "(X-Y)" variants
    if (patLower.includes('adds # to #')) {
      const alt = patLower.replace('adds # to #', 'adds (#-#)');
      entry = lookup.get(alt);
      if (entry) return buildResult(entry.id, allNumbers, pattern, modType);
    }
    if (patLower.includes('(#-#)')) {
      const alt = patLower.replace('(#-#)', '# to #');
      entry = lookup.get(alt);
      if (entry) return buildResult(entry.id, allNumbers, pattern, modType);
    }
  }

  // Last resort: try the line with ALL numbers as # (simplest form)
  const allHashPattern = cleanLine.replace(/-?\d+(\.\d+)?/g, '#').toLowerCase();
  const lastEntry = lookup.get(allHashPattern);
  if (lastEntry) return buildResult(lastEntry.id, allNumbers, allHashPattern, modType);

  // Check multi-line stat index — PoB splits multi-line trade stats into separate lines
  // e.g., bleed immunity + corrupted blood immunity is one stat in trade API but two lines in PoB
  const multiKey = `__multiline:${allHashPattern}`;
  const multiEntry = lookup.get(multiKey);
  if (multiEntry) return { id: multiEntry.id, value: {}, modType };

  return null;
}

/**
 * Build the match result with appropriate value handling.
 */
function buildResult(id, numbers, pattern, modType) {
  const isRange = /adds #|# to #/i.test(pattern) && numbers.length >= 2;

  if (isRange) {
    // For range stats (Adds X to Y), use average * 0.8 as minimum
    const avg = (parseFloat(numbers[0]) + parseFloat(numbers[1])) / 2;
    return { id, value: { min: Math.floor(avg * 0.8) }, modType };
  }

  const val = parseFloat(numbers[0]);
  if (val === 0) return { id, value: {}, modType };

  // Use 80% of value as minimum for searching (allows finding slightly worse items)
  return { id, value: { min: Math.floor(val * 0.8) }, modType };
}

export async function createTradeSearch(league, queryPayload) {
  const res = await rateLimitedFetch(`${TRADE_API}/search/${encodeURIComponent(league)}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(queryPayload),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Trade API ${res.status}: ${text.slice(0, 200)}`);
  }

  const data = await res.json();
  return data.id;
}

export function getTradeResultUrl(league, searchId) {
  return `${TRADE_SITE}/search/${encodeURIComponent(league)}/${searchId}`;
}

/**
 * Build a trade query for a unique item.
 * mode: 'basic' = name only, '6l' = name + 6 links, 'exact' = name + stat minimums
 * For 'exact' mode, guide stat values are treated as minimums (they represent minimum rolls).
 */
export async function buildUniqueQuery(item, mode = 'basic') {
  const query = {
    name: item.name,
    status: { option: 'securable' },
  };

  // Add base type if available and different from name
  if (item.baseType && item.baseType !== item.name) {
    query.type = item.baseType;
  }

  const payload = { query, sort: { price: 'asc' } };

  // 6-link filter
  if (mode === '6l') {
    query.filters = {
      socket_filters: { filters: { links: { min: 6 } } },
    };
  }

  // Exact stats — use guide values as minimums (they're minimum possible rolls)
  if (mode === 'exact' && item.stats?.length > 0) {
    const lookup = await loadStatLookup();
    const filters = [];

    for (const s of item.stats) {
      const line = s.rawLine || s.line || s;
      const match = matchModToStat(line, lookup);
      if (!match) continue;

      // Non-numeric mods (e.g. "Cannot be Frozen") — include as presence filter
      const cleanLine = line.replace(/\{[^}]*\}/g, '').replace(/ \(enchant\)| \(implicit\)| \(crafted\)| \(fractured\)| \(Searing Exarch\)| \(Eater of Worlds\)/gi, '').trim();
      const numbers = cleanLine.match(/-?\d+(\.\d+)?/g);
      if (!numbers) {
        filters.push({ id: match.id, value: {}, disabled: false });
        continue;
      }

      // Use raw value as minimum (guide = minimum roll), not the 80% that buildResult does
      const isRange = numbers.length >= 2 && /adds #|# to #/i.test(cleanLine.replace(/-?\d+(\.\d+)?/g, '#'));
      let minVal;
      if (isRange) {
        minVal = Math.floor((parseFloat(numbers[0]) + parseFloat(numbers[1])) / 2);
      } else {
        minVal = parseFloat(numbers[0]);
      }
      if (minVal === 0) continue;

      filters.push({ id: match.id, value: { min: minVal }, disabled: false });
    }

    if (filters.length > 0) {
      payload.query.stats = [{ type: 'and', filters }];
    }
  }

  return payload;
}

export async function searchGemTrade(league, gemName, level = 20, quality = null, { corrupted = false } = {}) {
  const gemFilters = {
    gem_level: { min: level },
  };
  if (corrupted !== 'any') gemFilters.corrupted = { option: corrupted };
  if (quality) gemFilters.quality = { min: quality };
  const query = {
    query: {
      type: gemName,
      filters: {
        misc_filters: { filters: gemFilters },
      },
      status: { option: 'securable' },
    },
    sort: { price: 'asc' },
  };
  const searchId = await createTradeSearch(league, query);
  return getTradeResultUrl(league, searchId);
}

/**
 * Map PoB slot name / base type to trade API category.
 * Returns { category, armour_filters } or null.
 */
function inferItemCategory(item) {
  const base = (item.baseType || '').toLowerCase();
  const slot = (item.slotName || '').toLowerCase();
  const props = item.properties || {};

  // Flasks — use base type (e.g., "Granite Flask", "Divine Life Flask") for exact searches
  if (base.includes('flask') || slot.startsWith('flask')) {
    return { category: 'flask', useBaseType: true };
  }

  // Jewels
  if (base.includes('jewel')) {
    if (base.includes('cobalt') || base.includes('viridian') || base.includes('crimson') || base.includes('prismatic'))
      return { category: 'jewel' };
    if (base.includes('ghastly') || base.includes('murderous') || base.includes('searching') || base.includes('hypnotic'))
      return { category: 'jewel.abyss' };
    if (base.includes('cluster'))
      return { category: 'jewel.cluster' };
    return { category: 'jewel' };
  }

  // Accessories
  if (base.includes('ring') && !base.includes('ringmail')) return { category: 'accessory.ring' };
  if (base.includes('amulet') || base.includes('talisman')) return { category: 'accessory.amulet' };
  if (base.includes('stygian'))
    return { category: 'accessory.belt', useBaseType: true };
  if (base.includes('belt') || base.includes('vise') || base.includes('sash'))
    return { category: 'accessory.belt' };

  // Weapons — detect by slot or base type keywords
  if (slot === 'weapon 1' || slot === 'weapon' || slot === 'weapon 2') {
    if (base.includes('wand') || base.includes('sceptre') || base.includes('rune dagger'))
      return { category: 'weapon.wand' };
    if (base.includes('staff') || base.includes('warstaff'))
      return { category: 'weapon.staff' };
    if (base.includes('bow'))
      return { category: 'weapon.bow' };
    if (base.includes('claw'))
      return { category: 'weapon.claw' };
    if (base.includes('dagger'))
      return { category: 'weapon.dagger' };
    if (base.includes('axe') || base.includes('hatchet') || base.includes('chopper') || base.includes('cleaver'))
      return { category: 'weapon.oneaxe' };
    if (base.includes('sword') || base.includes('sabre') || base.includes('rapier') || base.includes('blade'))
      return { category: 'weapon.onesword' };
    if (base.includes('mace') || base.includes('hammer') || base.includes('flail'))
      return { category: 'weapon.onemace' };
    return { category: 'weapon' };
  }

  // Shields
  if (slot === 'offhand' || slot === 'weapon 2 swap' || base.includes('shield') || base.includes('buckler')) {
    const armour_filters = {};
    if (props['Armour']) armour_filters.ar = { min: 1 };
    if (props['Evasion']) armour_filters.ev = { min: 1 };
    if (props['Energy Shield']) armour_filters.es = { min: 1 };
    return { category: 'armour.shield', armour_filters };
  }

  // Armour pieces — detect by slot name
  const armourSlotMap = {
    'helmet': 'armour.helmet', 'helm': 'armour.helmet',
    'body armour': 'armour.chest',
    'gloves': 'armour.gloves',
    'boots': 'armour.boots',
  };
  for (const [slotKey, cat] of Object.entries(armourSlotMap)) {
    if (slot.includes(slotKey)) {
      const armour_filters = {};
      if (props['Armour']) armour_filters.ar = { min: 1 };
      if (props['Evasion']) armour_filters.ev = { min: 1 };
      if (props['Energy Shield']) armour_filters.es = { min: 1 };
      return { category: cat, armour_filters };
    }
  }

  return null;
}

/**
 * Fetch PoB-powered mod weights from the server.
 * Returns null if PoB is unavailable (graceful fallback).
 */
export async function fetchWeights(pobCode, slotName, modLines) {
  try {
    const res = await fetch('/api/weights', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ pobCode, slotName, modLines }),
    });
    if (!res.ok) return null;
    return res.json();
  } catch {
    return null;
  }
}

/**
 * Batch weight calc — all slots in one call (one BuildOutput + one GetMiscCalculator).
 * slots: [{ slotName, modLines }, ...]
 * Returns { slotName: { weights, totalScore, totalDPS, totalEHP, ... } }
 */
export async function fetchWeightsBatch(pobCode, slots) {
  try {
    const res = await fetch('/api/compare', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ pobCode, slots }),
    });
    if (!res.ok) return null;
    return res.json();
  } catch {
    return null;
  }
}

/**
 * Map PoB slot names from our item parsing to PoB's internal slot names.
 */
function toPobSlotName(slotName) {
  const map = {
    'helmet': 'Helmet', 'helm': 'Helmet',
    'body armour': 'Body Armour', 'body': 'Body Armour',
    'gloves': 'Gloves',
    'boots': 'Boots',
    'belt': 'Belt',
    'amulet': 'Amulet',
    'ring 1': 'Ring 1', 'ring 2': 'Ring 2', 'ring': 'Ring 1',
    'weapon 1': 'Weapon 1', 'weapon': 'Weapon 1',
    'weapon 2': 'Weapon 2', 'offhand': 'Weapon 2',
    'flask 1': 'Flask 1', 'flask 2': 'Flask 2', 'flask 3': 'Flask 3',
    'flask 4': 'Flask 4', 'flask 5': 'Flask 5',
  };
  const lower = (slotName || '').toLowerCase();
  return map[lower] || slotName;
}

/**
 * Common mods with test values for PoB weight calc.
 * PoB needs real numbers — we use round values to get per-point weights.
 * Grouped by what can appear on different slot types.
 */
const WEIGHT_MOD_POOL = {
  // Universal mods (can roll on almost any rare)
  universal: [
    '+100 to maximum Life',
    '+50 to maximum Energy Shield',
    '+50 to maximum Mana',
    '+50 to Strength',
    '+50 to Dexterity',
    '+50 to Intelligence',
    '+50% to Fire Resistance',
    '+50% to Cold Resistance',
    '+50% to Lightning Resistance',
    '+20% to Chaos Resistance',
  ],
  // Armour slot mods (helm, body, gloves, boots, shield)
  armour: [
    '+500 to Armour',
    '+500 to Evasion Rating',
    '+100 to maximum Energy Shield',
    '10% increased maximum Life',
    'Regenerate 100 Life per second',
    '+1 to Level of all Minion Skill Gems',
  ],
  // Weapon mods
  weapon: [
    '100% increased Physical Damage',
    'Adds 10 to 50 Physical Damage',
    'Adds 10 to 50 Fire Damage',
    'Adds 10 to 50 Cold Damage',
    'Adds 1 to 50 Lightning Damage',
    '20% increased Attack Speed',
    '30% increased Critical Strike Chance',
    '+30% to Critical Strike Multiplier',
    '+1 to Level of all Spell Skill Gems',
    '+1 to Level of all Minion Skill Gems',
    '80% increased Minion Damage',
    '50% increased Spell Damage',
    'Adds 10 to 50 Fire Damage to Spells',
    'Adds 10 to 50 Cold Damage to Spells',
    'Adds 1 to 50 Lightning Damage to Spells',
  ],
  // Jewellery (ring, amulet, belt)
  jewellery: [
    'Adds 10 to 20 Physical Damage to Attacks',
    'Adds 10 to 20 Fire Damage to Attacks',
    'Adds 10 to 20 Cold Damage to Attacks',
    'Adds 1 to 40 Lightning Damage to Attacks',
    '20% increased Elemental Damage with Attack Skills',
    '30% increased Spell Damage',
    '+30% to Critical Strike Multiplier',
    '+20% to Global Critical Strike Multiplier',
    'Adds 10 to 20 Fire Damage to Spells',
    'Adds 10 to 20 Cold Damage to Spells',
    'Adds 1 to 40 Lightning Damage to Spells',
    '15% increased Cast Speed',
    'Regenerate 50 Life per second',
  ],
  // Amulet-specific
  amulet: [
    '+1 to Level of all Skill Gems',
    '+1 to Level of all Spell Skill Gems',
    '+1 to Level of all Minion Skill Gems',
    '+1 to Level of all Physical Skill Gems',
    '+1 to Level of all Fire Skill Gems',
    '+1 to Level of all Cold Skill Gems',
    '+1 to Level of all Lightning Skill Gems',
    '+1 to Level of all Chaos Skill Gems',
  ],
  // Belt-specific
  belt: [
    '15% increased Flask Effect Duration',
    '20% increased Flask Charges gained',
    '+500 to Armour',
    '+500 to Evasion Rating',
  ],
  // Boots-specific
  boots: [
    '30% increased Movement Speed',
  ],
  // Helmet-specific
  helmet: [
    '20% increased Mana Reservation Efficiency of Skills',
    '+2 to Level of all Minion Skill Gems',
  ],
  // Gloves-specific
  gloves: [
    '15% increased Attack Speed',
    'Adds 10 to 20 Physical Damage to Attacks',
    'Adds 10 to 20 Fire Damage to Attacks',
    'Adds 10 to 20 Cold Damage to Attacks',
    'Adds 1 to 40 Lightning Damage to Attacks',
  ],
};

/**
 * Get the full mod pool for a given PoB slot name.
 */
function getModPoolForSlot(slotName) {
  const mods = [...WEIGHT_MOD_POOL.universal];
  const lower = slotName.toLowerCase();

  if (lower.includes('weapon')) {
    mods.push(...WEIGHT_MOD_POOL.weapon);
  } else if (lower === 'amulet') {
    mods.push(...WEIGHT_MOD_POOL.armour, ...WEIGHT_MOD_POOL.jewellery, ...WEIGHT_MOD_POOL.amulet);
  } else if (lower.startsWith('ring')) {
    mods.push(...WEIGHT_MOD_POOL.jewellery);
  } else if (lower === 'belt') {
    mods.push(...WEIGHT_MOD_POOL.armour, ...WEIGHT_MOD_POOL.jewellery, ...WEIGHT_MOD_POOL.belt);
  } else if (lower === 'helmet') {
    mods.push(...WEIGHT_MOD_POOL.armour, ...WEIGHT_MOD_POOL.helmet);
  } else if (lower === 'gloves') {
    mods.push(...WEIGHT_MOD_POOL.armour, ...WEIGHT_MOD_POOL.gloves);
  } else if (lower === 'boots') {
    mods.push(...WEIGHT_MOD_POOL.armour, ...WEIGHT_MOD_POOL.boots);
  } else {
    // Body armour, shield, etc.
    mods.push(...WEIGHT_MOD_POOL.armour);
  }

  // Dedupe
  return [...new Set(mods)];
}

/**
 * Fetch weights for ALL common mods on a slot (for weighted trade search).
 * Returns { weights: [{ line, weight, dpsPercent, ehpPercent }], ... }
 */
export async function fetchSlotWeights(pobCode, slotName) {
  const modLines = getModPoolForSlot(slotName);
  try {
    const res = await fetch('/api/compare', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ pobCode, slots: [{ slotName, modLines }] }),
    });
    if (!res.ok) return null;
    const data = await res.json();
    return data[slotName] || null;
  } catch {
    return null;
  }
}

export async function buildTradeQuery(item, weights = null) {
  const [types, lookup] = await Promise.all([loadBaseTypes(), loadStatLookup()]);

  const query = {
    status: { option: 'securable' },
  };

  if (item.rarity === 'Unique') {
    // Uniques: search by name + base type (exact match)
    query.name = item.name;
    if (types.has(item.baseType)) {
      query.type = item.baseType;
    }
  } else {
    // Non-uniques: search by CATEGORY (boots, helmet, etc.) not specific base type
    const catInfo = inferItemCategory(item);
    const rarityFilter = item.rarity === 'Magic' ? 'magic' : 'nonunique';

    query.filters = {
      type_filters: {
        filters: {
          rarity: { option: rarityFilter },
        },
      },
    };

    if (catInfo) {
      query.filters.type_filters.filters.category = { option: catInfo.category };
      // Flasks and Stygian Vise: search by exact base type name
      if (catInfo.useBaseType && types.has(item.baseType)) {
        query.type = item.baseType;
      }
      // Add defence type filters (ar/ev/es min 1) so results match the defence archetype
      if (catInfo.armour_filters && Object.keys(catInfo.armour_filters).length > 0) {
        query.filters.armour_filters = { filters: catInfo.armour_filters };
      }
    } else {
      // Fallback: use base type if we can't infer category
      if (types.has(item.baseType)) {
        query.type = item.baseType;
      }
    }
  }

  const filters = [];
  const seenIds = new Set();

  if (weights?.weights) {
    // Weighted mode: match ALL PoB-weighted mods to trade stat IDs
    for (const w of weights.weights) {
      if (Math.abs(w.weight) < 0.01) continue; // skip zero-impact mods
      const matched = matchModToStat(w.line, lookup);
      if (matched && !seenIds.has(matched.id)) {
        seenIds.add(matched.id);
        filters.push({
          id: matched.id,
          value: { weight: Math.round(w.weight * 100) / 100 },
        });
      }
    }
  } else {
    // Non-weighted: match item stats with min values
    for (const line of (item.stats || [])) {
      const matched = matchModToStat(line, lookup);
      if (matched && !seenIds.has(matched.id)) {
        seenIds.add(matched.id);
        filters.push({
          id: matched.id,
          value: matched.value,
        });
      }
    }
  }

  if (weights?.weights) {
    // Weighted query: sort by abs weight descending, cap at ~20 filters (trade API limit)
    filters.sort((a, b) => Math.abs(b.value.weight) - Math.abs(a.value.weight));
    const capped = filters.slice(0, 20);

    // minWeight threshold: half of guide item's score
    // This means "find items at least half as good as the guide"
    const minWeight = Math.max(
      Math.round((weights.guideScore || weights.totalScore || 0) * 0.5),
      1 // at least 1 so we don't get zero-value junk
    );

    query.stats = [{ type: 'weight', value: { min: minWeight }, filters: capped }];

    return {
      query,
      sort: { 'statgroup.0': 'desc' }, // sort by weighted sum (best upgrades first)
    };
  } else {
    // Fallback: AND query with flat mins, sort by price
    query.stats = [{ type: 'and', filters }];

    return {
      query,
      sort: { price: 'asc' },
    };
  }
}

export { toPobSlotName };

const GGG_SLOT_MAP = {
  'Helm': 'Helmet', 'BodyArmour': 'Body Armour',
  'Gloves': 'Gloves', 'Boots': 'Boots', 'Belt': 'Belt',
  'Amulet': 'Amulet', 'Ring': 'Ring 1', 'Ring2': 'Ring 2',
  'Weapon': 'Weapon 1', 'Weapon2': 'Weapon 2', 'Offhand': 'Weapon 2',
};

/**
 * Parse GGG API items into { slotName: { name, baseType, mods, ilvl, rarity } }.
 */
export function parseGggItems(apiItems) {
  const result = {};
  for (const item of apiItems) {
    let slot = GGG_SLOT_MAP[item.inventoryId];
    if (item.inventoryId === 'Flask') slot = `Flask ${(item.x || 0) + 1}`;
    if (!slot) continue;
    const name = (item.name || '').replace(/<<[^>]+>>/g, '').trim();
    // Don't include implicits — test item already has base type implicits
    const mods = [
      ...(item.explicitMods || []),
      ...(item.craftedMods || []),
      ...(item.fracturedMods || []),
      ...(item.enchantMods || []),
    ];
    result[slot] = {
      name: name || item.typeLine,
      baseType: item.typeLine,
      mods,
      ilvl: item.ilvl,
      frameType: item.frameType, // 0=normal,1=magic,2=rare,3=unique
    };
  }
  return result;
}

/**
 * Test stat matching against all item stats and return match report.
 * Useful for debugging — shows which stats matched and which didn't.
 */
export async function debugStatMatching(stats) {
  const lookup = await loadStatLookup();
  const results = [];
  for (const line of stats) {
    const matched = matchModToStat(line, lookup);
    results.push({
      line,
      matched: matched ? { id: matched.id, value: matched.value, modType: matched.modType } : null,
    });
  }
  return results;
}
