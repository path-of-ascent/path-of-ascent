/**
 * Server-side PoB XML parser.
 * Extracts spec, skill set, item set, and item data from PoB export XML.
 * Uses regex — PoB XML is regular enough that a full parser isn't needed.
 */

/**
 * Parse all <Spec> elements from PoB XML.
 * Returns array of { title, nodes: number[], masteryEffects: {nodeId: effectId}, jewelSockets: {nodeId: itemId} }
 */
export function parseSpecs(xml) {
  const specs = [];
  const specRegex = /<Spec\s([^>]*)>([\s\S]*?)<\/Spec>/g;
  let match;

  while ((match = specRegex.exec(xml)) !== null) {
    const attrs = match[1];
    const body = match[2];

    const title = extractAttr(attrs, 'title') || `Tree ${specs.length + 1}`;
    const treeVersion = extractAttr(attrs, 'treeVersion') || '';

    // Parse tree URL to get allocated node IDs
    const urlMatch = body.match(/<URL>([\s\S]*?)<\/URL>/);
    const urlText = urlMatch ? urlMatch[1].trim() : '';
    const nodes = decodeTreeUrl(urlText);

    // Parse mastery effects: format is "{nodeId,effectId}{nodeId,effectId}..."
    const masteryStr = extractAttr(attrs, 'masteryEffects') || '';
    const masteryEffects = {};
    for (const m of masteryStr.matchAll(/\{(\d+),(\d+)\}/g)) {
      masteryEffects[m[1]] = parseInt(m[2]);
    }

    // Parse jewel sockets
    const jewelSockets = {};
    const socketsEl = body.match(/<Sockets>([\s\S]*?)<\/Sockets>/);
    if (socketsEl) {
      const socketRegex = /<Socket\s+nodeId="(\d+)"\s+itemId="(\d+)"\/>/g;
      let sm;
      while ((sm = socketRegex.exec(socketsEl[1])) !== null) {
        jewelSockets[sm[1]] = sm[2];
      }
    }

    // Parse class info
    const classId = parseInt(extractAttr(attrs, 'classId') || '0');
    const ascendClassId = parseInt(extractAttr(attrs, 'ascendClassId') || '0');

    specs.push({ title, treeVersion, nodes, masteryEffects, jewelSockets, classId, ascendClassId });
  }

  return specs;
}

/**
 * Parse all <SkillSet> elements.
 * Returns array of arrays of { slot, enabled, gems: [{name, level, quality, enabled, skillId}] }
 */
export function parseSkillSets(xml) {
  const sets = [];
  const setRegex = /<SkillSet\s[^>]*>([\s\S]*?)<\/SkillSet>/g;
  let match;

  while ((match = setRegex.exec(xml)) !== null) {
    const body = match[1];
    const skills = parseSkillsFromBody(body);
    sets.push(skills);
  }

  // If no SkillSets, parse top-level <Skill> elements
  if (sets.length === 0) {
    const skills = parseSkillsFromBody(xml);
    if (skills.length > 0) sets.push(skills);
  }

  return sets;
}

function parseSkillsFromBody(body) {
  const skills = [];
  const skillRegex = /<Skill\s([\s\S]*?)>([\s\S]*?)<\/Skill>/g;
  let match;

  while ((match = skillRegex.exec(body)) !== null) {
    const attrs = match[1];
    const gemBody = match[2];

    const slot = extractAttr(attrs, 'slot') || '';
    const enabled = extractAttr(attrs, 'enabled') !== 'false';
    const label = extractAttr(attrs, 'label') || '';

    const gems = [];
    const gemRegex = /<Gem\s([\s\S]*?)\/>/g;
    let gm;
    while ((gm = gemRegex.exec(gemBody)) !== null) {
      const ga = gm[1];
      const name = extractAttr(ga, 'nameSpec') || extractAttr(ga, 'skillId') || '';
      const level = parseInt(extractAttr(ga, 'level') || '1');
      const quality = parseInt(extractAttr(ga, 'quality') || '0');
      const gemEnabled = extractAttr(ga, 'enabled') !== 'false';
      const skillId = extractAttr(ga, 'skillId') || '';
      if (name) {
        gems.push({ name, level, quality, enabled: gemEnabled, skillId });
      }
    }

    if (gems.length > 0) {
      skills.push({ slot, enabled, label, gems });
    }
  }

  return skills;
}

/**
 * Parse all <ItemSet> elements.
 * Returns array of { title, slots: {slotName: itemId} }
 */
export function parseItemSets(xml) {
  const sets = [];
  const setRegex = /<ItemSet\s([^>]*)>([\s\S]*?)<\/ItemSet>/g;
  let match;

  while ((match = setRegex.exec(xml)) !== null) {
    const attrs = match[1];
    const body = match[2];
    const title = extractAttr(attrs, 'title') || `Set ${sets.length + 1}`;
    const id = extractAttr(attrs, 'id') || '';

    const slots = {};
    const slotRegex = /<Slot\s+[^>]*name="([^"]+)"[^>]*itemId="(\d+)"[^>]*\/>/g;
    let sm;
    while ((sm = slotRegex.exec(body)) !== null) {
      if (sm[2] !== '0') slots[sm[1]] = sm[2]; // skip itemId="0" (empty slots)
    }

    sets.push({ title, id, slots });
  }

  return sets;
}

/**
 * Parse all <Item> elements into a map of id → raw text content.
 */
export function parseItems(xml) {
  const items = {};
  const itemRegex = /<Item\s+id="(\d+)"[^>]*>([\s\S]*?)<\/Item>/g;
  let match;

  while ((match = itemRegex.exec(xml)) !== null) {
    const id = match[1];
    // Strip XML child elements (<ModRange>, etc.) — keep only plain text lines
    // Decode XML entities in item text
    const rawText = decodeXmlEntities(
      match[2]
        .split('\n')
        .map(l => l.trim())
        .filter(l => l && !l.startsWith('<'))
        .join('\n')
    );
    items[id] = rawText;
  }

  return items;
}

/**
 * Extract the active spec/skillset/itemset indices.
 */
export function parseActiveIndices(xml) {
  const specMatch = xml.match(/activeSpec="(\d+)"/);
  const skillSetMatch = xml.match(/activeSkillSet="(\d+)"/);
  const itemSetMatch = xml.match(/activeItemSet="(\d+)"/);

  return {
    activeSpec: specMatch ? parseInt(specMatch[1]) - 1 : 0,      // PoB is 1-indexed
    activeSkillSet: skillSetMatch ? parseInt(skillSetMatch[1]) - 1 : 0,
    activeItemSet: itemSetMatch ? parseInt(itemSetMatch[1]) - 1 : 0,
  };
}

/**
 * Parse build-level info (class, level, bandit, etc.)
 */
export function parseBuildInfo(xml) {
  const buildMatch = xml.match(/<Build\s([^>]*)>/);
  if (!buildMatch) return {};
  const attrs = buildMatch[1];
  return {
    className: extractAttr(attrs, 'className') || '',
    ascendClassName: extractAttr(attrs, 'ascendClassName') || '',
    level: parseInt(extractAttr(attrs, 'level') || '1'),
    bandit: extractAttr(attrs, 'bandit') || 'None',
  };
}

// --- Helpers ---

function extractAttr(attrString, name) {
  // Handle both name="value" and name='value'
  const regex = new RegExp(`${name}="([^"]*)"`, 'i');
  const match = attrString.match(regex);
  if (match) return decodeXmlEntities(match[1]);
  const regex2 = new RegExp(`${name}='([^']*)'`, 'i');
  const match2 = attrString.match(regex2);
  return match2 ? decodeXmlEntities(match2[1]) : null;
}

function decodeXmlEntities(str) {
  return str
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&apos;/g, "'")
    .replace(/&quot;/g, '"');
}

/**
 * Decode a PoB tree URL hash into an array of node IDs.
 * Same logic as the client-side decodeTreeUrl in PassiveTree.jsx.
 */
function decodeTreeUrl(url) {
  if (!url) return [];
  const parts = url.replace(/\s+/g, '').split('/');
  const hash = parts[parts.length - 1];
  if (!hash || hash.length < 4) return [];

  try {
    const b64 = hash.replace(/-/g, '+').replace(/_/g, '/');
    const raw = Buffer.from(b64, 'base64');
    const ver = (raw[0] << 24) | (raw[1] << 16) | (raw[2] << 8) | raw[3];
    let offset = ver >= 4 ? 7 : 6;
    const nodes = [];
    while (offset + 1 < raw.length) {
      const nodeId = (raw[offset] << 8) | raw[offset + 1];
      if (nodeId > 0) nodes.push(nodeId);
      offset += 2;
    }
    return nodes;
  } catch {
    return [];
  }
}
