import { describe, it, expect, beforeAll } from 'vitest';
import { readFileSync } from 'fs';
import { inflate } from 'pako';
import {
  parseSpecs,
  parseSkillSets,
  parseItemSets,
  parseItems,
  parseActiveIndices,
  parseBuildInfo,
} from '../pob-xml-parser.js';

// --- Decode the Doryani test build ---
let doryaniXml;

beforeAll(() => {
  const raw = readFileSync('diagnostics/test-pob-code.txt', 'utf-8').trim();
  const b64 = raw.replace(/-/g, '+').replace(/_/g, '/');
  const buf = Buffer.from(b64, 'base64');
  doryaniXml = inflate(buf, { to: 'string' });
});

describe('parseBuildInfo', () => {
  it('extracts class, ascendancy, and level', () => {
    const info = parseBuildInfo(doryaniXml);
    expect(info.className).toBe('Templar');
    expect(info.ascendClassName).toBe('Guardian');
    expect(info.level).toBeGreaterThanOrEqual(90);
  });
});

describe('parseActiveIndices', () => {
  it('returns valid 0-indexed spec/skillset/itemset indices', () => {
    const indices = parseActiveIndices(doryaniXml);
    expect(indices.activeSpec).toBeGreaterThanOrEqual(0);
    expect(indices.activeSkillSet).toBeGreaterThanOrEqual(0);
    expect(indices.activeItemSet).toBeGreaterThanOrEqual(0);
    // Doryani build has active spec 9 (1-indexed) = 8 (0-indexed)
    expect(indices.activeSpec).toBe(8);
  });
});

describe('parseSpecs', () => {
  it('finds all 11 specs', () => {
    const specs = parseSpecs(doryaniXml);
    expect(specs).toHaveLength(11);
  });

  it('extracts correct titles for progression specs', () => {
    const specs = parseSpecs(doryaniXml);
    expect(specs[0].title).toContain('Brutus');
    expect(specs[7].title).toContain('90+');
    expect(specs[8].title).toContain('Endgame Doryani');
    expect(specs[10].title).toContain('100');
  });

  it('spec 8 (Lvl 90+) has 3 jewel sockets', () => {
    const specs = parseSpecs(doryaniXml);
    const spec8 = specs[7]; // 0-indexed
    const socketCount = Object.keys(spec8.jewelSockets).length;
    expect(socketCount).toBe(3);
  });

  it('spec 9 (Endgame Doryani) has 11 jewel sockets', () => {
    const specs = parseSpecs(doryaniXml);
    const spec9 = specs[8]; // 0-indexed
    const socketCount = Object.keys(spec9.jewelSockets).length;
    expect(socketCount).toBe(11);
  });

  it('spec 9 jewel sockets include Glorious Vanity (item 86) at node 61419', () => {
    const specs = parseSpecs(doryaniXml);
    const spec9 = specs[8];
    expect(spec9.jewelSockets['61419']).toBe('86');
  });

  it('spec 9 jewel sockets include Thread of Hope (item 81) at node 26196', () => {
    const specs = parseSpecs(doryaniXml);
    const spec9 = specs[8];
    expect(spec9.jewelSockets['26196']).toBe('81');
  });

  it('spec 8 jewel sockets include Reckless Defence (item 76) at node 36634', () => {
    const specs = parseSpecs(doryaniXml);
    const spec8 = specs[7];
    expect(spec8.jewelSockets['36634']).toBe('76');
  });

  it('each spec has non-empty tree nodes', () => {
    const specs = parseSpecs(doryaniXml);
    // Skip early leveling specs that might be minimal
    for (const spec of specs.slice(5)) {
      expect(spec.nodes.length).toBeGreaterThan(50);
    }
  });

  it('spec 9 has mastery effects', () => {
    const specs = parseSpecs(doryaniXml);
    const spec9 = specs[8];
    const masteryCount = Object.keys(spec9.masteryEffects).length;
    expect(masteryCount).toBeGreaterThan(0);
  });

  it('specs have classId from build info (may be 0 if not set per-spec)', () => {
    const specs = parseSpecs(doryaniXml);
    const spec9 = specs[8];
    // classId may not be set per-spec in all builds — build-level className is authoritative
    expect(typeof spec9.classId).toBe('number');
  });
});

describe('parseItems', () => {
  it('parses items into a map by ID', () => {
    const items = parseItems(doryaniXml);
    expect(Object.keys(items).length).toBeGreaterThan(30);
  });

  it('contains Glorious Vanity (item 86)', () => {
    const items = parseItems(doryaniXml);
    expect(items['86']).toBeDefined();
    expect(items['86']).toContain('Glorious Vanity');
  });

  it('contains Thread of Hope (item 81)', () => {
    const items = parseItems(doryaniXml);
    expect(items['81']).toBeDefined();
    expect(items['81']).toContain('Thread of Hope');
  });

  it('contains Grand Spectrum (item 92)', () => {
    const items = parseItems(doryaniXml);
    expect(items['92']).toBeDefined();
    expect(items['92']).toContain('Grand Spectrum');
  });

  it('contains Watcher\'s Eye (item 96)', () => {
    const items = parseItems(doryaniXml);
    expect(items['96']).toBeDefined();
    expect(items['96']).toContain('Watcher');
  });

  it('contains Large Cluster Jewel (item 117)', () => {
    const items = parseItems(doryaniXml);
    expect(items['117']).toBeDefined();
    expect(items['117']).toContain('Large Cluster Jewel');
  });

  it('contains Small Cluster Jewel (item 83) with Enduring Composure', () => {
    const items = parseItems(doryaniXml);
    expect(items['83']).toBeDefined();
    expect(items['83']).toContain('Small Cluster Jewel');
    expect(items['83']).toContain('EnduringComposure');
  });

  it('item text includes rarity and base type', () => {
    const items = parseItems(doryaniXml);
    // Sol Star is a rare Crimson Jewel (item 49)
    expect(items['49']).toContain('Rarity: RARE');
    expect(items['49']).toContain('Crimson Jewel');
  });
});

describe('parseSkillSets', () => {
  it('finds all 11 skill sets (one per spec)', () => {
    const sets = parseSkillSets(doryaniXml);
    expect(sets.length).toBe(11);
  });

  it('skill set 9 (Endgame Doryani) has Vaal Absolution in Body Armour', () => {
    const sets = parseSkillSets(doryaniXml);
    const set9 = sets[8]; // 0-indexed
    const bodyArmour = set9.find(s => s.slot === 'Body Armour' && s.enabled);
    expect(bodyArmour).toBeDefined();
    const absolution = bodyArmour.gems.find(g => g.name === 'Vaal Absolution');
    expect(absolution).toBeDefined();
    expect(absolution.level).toBe(20);
  });

  it('skill set 9 has Purity of Fire in Helmet', () => {
    const sets = parseSkillSets(doryaniXml);
    const set9 = sets[8];
    const helmet = set9.find(s => s.slot === 'Helmet' && s.enabled);
    expect(helmet).toBeDefined();
    const pof = helmet.gems.find(g => g.name === 'Purity of Fire');
    expect(pof).toBeDefined();
    expect(pof.level).toBe(21);
  });

  it('skill set 8 (Lvl 90+) has Flesh and Stone in Helmet (not Purity of Fire)', () => {
    const sets = parseSkillSets(doryaniXml);
    const set8 = sets[7];
    const helmet = set8.find(s => s.slot === 'Helmet' && s.enabled);
    expect(helmet).toBeDefined();
    const fas = helmet.gems.find(g => g.name === 'Flesh and Stone');
    expect(fas).toBeDefined();
    const pof = helmet.gems.find(g => g.name === 'Purity of Fire');
    expect(pof).toBeUndefined();
  });

  it('skill set 8 has Elemental Weakness (removed in set 9)', () => {
    const sets = parseSkillSets(doryaniXml);
    const set8 = sets[7];
    const weaponSkill = set8.find(s => s.slot === 'Weapon 1' && s.enabled &&
      s.gems.some(g => g.name === 'Elemental Weakness'));
    expect(weaponSkill).toBeDefined();
  });

  it('skill set 9 has Punishment (not in set 8)', () => {
    const sets = parseSkillSets(doryaniXml);
    const set9 = sets[8];
    const weaponSkill = set9.find(s => s.slot === 'Weapon 1' && s.enabled &&
      s.gems.some(g => g.name === 'Punishment'));
    expect(weaponSkill).toBeDefined();
  });
});

describe('parseItemSets', () => {
  it('finds all item sets', () => {
    const sets = parseItemSets(doryaniXml);
    expect(sets.length).toBeGreaterThan(0);
  });

  it('at least one item set has equipment slot mappings', () => {
    const sets = parseItemSets(doryaniXml);
    const withSlots = sets.filter(s => Object.keys(s.slots).length > 0);
    expect(withSlots.length).toBeGreaterThan(0);
    // The main sets should have 8+ equipment slots
    const biggest = Math.max(...sets.map(s => Object.keys(s.slots).length));
    expect(biggest).toBeGreaterThanOrEqual(8);
  });

  it('item sets have titles', () => {
    const sets = parseItemSets(doryaniXml);
    for (const set of sets) {
      expect(set.title).toBeDefined();
      expect(set.title.length).toBeGreaterThan(0);
    }
  });
});
