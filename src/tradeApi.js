import { tradeFetch, isElectron } from './api';

const TRADE_API = isElectron ? '/api/trade' : '/api/trade';
const TRADE_SITE = 'https://www.pathofexile.com/trade';
const RATE_LIMIT_DELAY = 1100;

let lastRequestTime = 0;
let validBaseTypes = null;
let statLookup = null; // pattern → { id, type }

async function apiFetch(url, options) {
  return tradeFetch(url, options);
}

async function rateLimitedFetch(url, options) {
  const now = Date.now();
  const elapsed = now - lastRequestTime;
  if (elapsed < RATE_LIMIT_DELAY) {
    await new Promise(r => setTimeout(r, RATE_LIMIT_DELAY - elapsed));
  }
  lastRequestTime = Date.now();
  return apiFetch(url, options);
}

async function loadBaseTypes() {
  if (validBaseTypes) return validBaseTypes;
  try {
    const res = await apiFetch(`${TRADE_API}/data/items`);
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
 * Load ALL stat data from trade API into a comprehensive lookup.
 * Key insight from Awakened PoE Trade: exact string matching only,
 * with all possible # placeholder patterns pre-indexed.
 */
async function loadStatLookup() {
  if (statLookup) return statLookup;
  statLookup = new Map();
  try {
    const res = await apiFetch(`${TRADE_API}/data/stats`);
    if (!res.ok) return statLookup;
    const data = await res.json();

    // Priority: pseudo > explicit > implicit > crafted > enchant > fractured
    // Pseudo first because they're most useful for trade searches (aggregate across sources)
    const priority = { pseudo: 0, explicit: 1, implicit: 2, crafted: 3, enchant: 4, fractured: 5 };

    for (const group of data.result) {
      const groupLabel = group.label; // "Pseudo", "Explicit", etc.
      for (const entry of group.entries) {
        if (!entry.id || !entry.text) continue;

        // Normalize: collapse newlines, trim, lowercase
        const normalized = entry.text.replace(/\n/g, ' ').trim().toLowerCase();
        const prefix = entry.id.split('.')[0];
        const prio = priority[prefix] ?? 6;

        const existing = statLookup.get(normalized);
        if (!existing || prio < existing.prio) {
          statLookup.set(normalized, { id: entry.id, prio, type: prefix });
        }

        // Also store variant with (#-#) ↔ # to # conversion
        if (normalized.includes('(#-#)')) {
          const alt = normalized.replace(/\(#-#\)/g, '# to #');
          const ex2 = statLookup.get(alt);
          if (!ex2 || prio < ex2.prio) {
            statLookup.set(alt, { id: entry.id, prio, type: prefix });
          }
        }
        if (normalized.includes('# to #') && !normalized.includes('(#-#)')) {
          const alt = normalized.replace(/# to #/g, '(#-#)');
          const ex2 = statLookup.get(alt);
          if (!ex2 || prio < ex2.prio) {
            statLookup.set(alt, { id: entry.id, prio, type: prefix });
          }
        }
      }
    }
    console.log(`Loaded ${statLookup.size} stat patterns from trade API`);
    return statLookup;
  } catch {
    return statLookup;
  }
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
 * Detect modifier type from PoB mod line suffixes.
 * PoB appends (implicit), (crafted), (enchant), (fractured) to mod lines.
 */
function detectModType(line) {
  if (/ \(implicit\)$/i.test(line)) return 'implicit';
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
  const cleanLine = line.replace(/ \(enchant\)| \(implicit\)| \(crafted\)| \(fractured\)/gi, '').trim();

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

  // Match all item stats to trade API stat IDs using combinatorial matching
  const filters = [];
  const seenIds = new Set();
  for (const line of (item.stats || [])) {
    const matched = matchModToStat(line, lookup);
    if (matched && !seenIds.has(matched.id)) {
      seenIds.add(matched.id);
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
