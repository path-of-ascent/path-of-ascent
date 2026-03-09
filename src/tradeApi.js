const TRADE_API = '/api/trade';
const TRADE_SITE = 'https://www.pathofexile.com/trade';
const RATE_LIMIT_DELAY = 1100;

let lastRequestTime = 0;
let validBaseTypes = null;
let statLookup = null; // pattern → stat id

async function rateLimitedFetch(url, options) {
  const now = Date.now();
  const elapsed = now - lastRequestTime;
  if (elapsed < RATE_LIMIT_DELAY) {
    await new Promise(r => setTimeout(r, RATE_LIMIT_DELAY - elapsed));
  }
  lastRequestTime = Date.now();
  return fetch(url, options);
}

async function loadBaseTypes() {
  if (validBaseTypes) return validBaseTypes;
  try {
    const res = await fetch(`${TRADE_API}/data/items`);
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
    return new Set();
  }
}

/**
 * Load stat data from trade API. Prioritize explicit > pseudo > implicit > crafted.
 * For each text pattern, store the best stat ID.
 */
async function loadStatLookup() {
  if (statLookup) return statLookup;
  statLookup = new Map();
  try {
    const res = await fetch(`${TRADE_API}/data/stats`);
    if (!res.ok) return statLookup;
    const data = await res.json();

    // Priority: explicit first, then others (pseudo handled separately)
    const priority = { explicit: 0, implicit: 1, crafted: 2, enchant: 3, fractured: 4 };

    for (const group of data.result) {
      for (const entry of group.entries) {
        if (!entry.id || !entry.text) continue;
        // Skip pseudo stats here — we handle those manually
        if (entry.id.startsWith('pseudo.')) continue;

        const normalized = entry.text.replace(/\n/g, ' ').trim().toLowerCase();
        const prefix = entry.id.split('.')[0];
        const prio = priority[prefix] ?? 5;

        const existing = statLookup.get(normalized);
        if (!existing || prio < existing.prio) {
          statLookup.set(normalized, { id: entry.id, prio });
        }
      }
    }
    return statLookup;
  } catch {
    return statLookup;
  }
}

// Pseudo stat mapping for common mods (these aggregate across all mod sources)
const PSEUDO_STATS = {
  '+# to maximum life': 'pseudo.pseudo_total_life',
  '+# to maximum mana': 'pseudo.pseudo_total_mana',
  '+# to maximum energy shield': 'pseudo.pseudo_total_energy_shield',
  '+#% to fire resistance': 'pseudo.pseudo_total_fire_resistance',
  '+#% to cold resistance': 'pseudo.pseudo_total_cold_resistance',
  '+#% to lightning resistance': 'pseudo.pseudo_total_lightning_resistance',
  '+#% to chaos resistance': 'pseudo.pseudo_total_chaos_resistance',
  '+#% to all elemental resistances': 'pseudo.pseudo_total_elemental_resistance',
  '+# to strength': 'pseudo.pseudo_total_strength',
  '+# to dexterity': 'pseudo.pseudo_total_dexterity',
  '+# to intelligence': 'pseudo.pseudo_total_intelligence',
  '+# to all attributes': 'pseudo.pseudo_total_all_attributes',
  '#% increased movement speed': 'pseudo.pseudo_increased_movement_speed',
  '+#% to global critical strike multiplier': 'pseudo.pseudo_total_critical_strike_multiplier',
  '+# to level of all minion skill gems': 'pseudo.pseudo_total_all_minion_skill_gem_level',
};

/**
 * Try to find a stat ID for a given mod line from a PoB item.
 */
function matchModToStat(line, lookup) {
  const cleanLine = line.replace(/ \(enchant\)| \(implicit\)| \(crafted\)| \(fractured\)/g, '').trim();
  const numbers = cleanLine.match(/-?\d+(\.\d+)?/g);
  if (!numbers) return null;

  let pattern = cleanLine.replace(/-?\d+(\.\d+)?/g, '#');
  const isRange = pattern.includes('Adds # to #');
  const patternLower = pattern.toLowerCase();

  // Try pseudo stats first (most useful for searching)
  let id = PSEUDO_STATS[patternLower];

  // Try explicit stat lookup
  if (!id) {
    const entry = lookup.get(patternLower);
    if (entry) id = entry.id;
  }

  // Try with "Adds (#-#)" variant
  if (!id && isRange) {
    const altPattern = patternLower.replace('adds # to #', 'adds (#-#)');
    const entry = lookup.get(altPattern);
    if (entry) id = entry.id;
  }

  if (!id) return null;

  if (isRange && numbers.length >= 2) {
    const avg = (parseFloat(numbers[0]) + parseFloat(numbers[1])) / 2;
    return { id, value: { min: Math.floor(avg * 0.8) } };
  }

  return { id, value: { min: Math.floor(parseFloat(numbers[0]) * 0.8) } };
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

export async function buildTradeQuery(item) {
  const [types, lookup] = await Promise.all([loadBaseTypes(), loadStatLookup()]);

  const query = {
    status: { option: 'securable' },
  };

  if (item.rarity === 'Unique') {
    query.name = item.name;
    if (types.has(item.baseType)) {
      query.type = item.baseType;
    }
  } else {
    if (types.has(item.baseType)) {
      query.type = item.baseType;
    }
    const rarityFilter = item.rarity === 'Magic' ? 'magic' : 'nonunique';
    query.filters = {
      type_filters: {
        filters: {
          rarity: { option: rarityFilter },
        },
      },
    };
  }

  // Dynamically match all item stats to trade API stat IDs
  const filters = [];
  for (const line of (item.stats || [])) {
    const matched = matchModToStat(line, lookup);
    if (matched) {
      filters.push({
        id: matched.id,
        value: matched.value,
        disabled: false,
      });
    }
  }

  query.stats = [{ type: 'and', filters }];

  return {
    query,
    sort: { price: 'asc' },
  };
}
