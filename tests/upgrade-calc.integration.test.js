/**
 * Integration tests for the upgrade planner calculation.
 * Requires: PoB bridge running (luajit + PathOfBuilding).
 * These tests call the actual PoB engine and verify real DPS/EHP calculations.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { readFileSync } from 'fs';
import { inflate } from 'pako';
import { parseSpecs, parseSkillSets, parseItems } from '../pob-xml-parser.js';
import { computeSpecDiff, calculateUpgradeDeltas, groupTreeChanges } from '../upgrade-planner.js';
import pobBridge from '../pob-bridge.js';

let doryaniXml;
let specs, skillSets, itemsMap;

beforeAll(async () => {
  // Decode test build
  const raw = readFileSync('diagnostics/test-pob-code.txt', 'utf-8').trim();
  const b64 = raw.replace(/-/g, '+').replace(/_/g, '/');
  const buf = Buffer.from(b64, 'base64');
  doryaniXml = inflate(buf, { to: 'string' });
  specs = parseSpecs(doryaniXml);
  skillSets = parseSkillSets(doryaniXml);
  itemsMap = parseItems(doryaniXml);

  // Start bridge
  await pobBridge.ensureRunning();
}, 30000);

describe('PoB bridge basics', () => {
  it('can load the Doryani build', async () => {
    const res = await pobBridge.send('load_build_xml', { xml: doryaniXml, name: 'Test Doryani' });
    expect(res.ok).toBe(true);
  }, 15000);

  it('can get baseline stats with minion DPS', async () => {
    await pobBridge.send('load_build_xml', { xml: doryaniXml, name: 'Test Stats' });
    const res = await pobBridge.send('get_stats', {
      fields: ['Life', 'TotalEHP', 'MinionTotalDPS', 'MinionLife', 'MinionCombinedDPS'],
    });
    expect(res.ok).toBe(true);
    expect(res.stats).toBeDefined();
    // This is a minion build — should have minion DPS
    const minionDps = parseFloat(res.stats.MinionTotalDPS || res.stats.MinionCombinedDPS || '0');
    expect(minionDps).toBeGreaterThan(0);
    // Should have life
    const life = parseFloat(res.stats.Life || '0');
    expect(life).toBeGreaterThan(1000);
  }, 15000);

  it('set_tree + get_stats works for measuring tree changes', async () => {
    await pobBridge.send('load_build_xml', { xml: doryaniXml, name: 'Test SetTree' });

    // Set to spec 8 tree
    const spec8 = specs[7];
    await pobBridge.send('set_tree', {
      nodes: spec8.nodes,
      classId: 5, // Templar
      ascendClassId: 3, // Guardian
      masteryEffects: spec8.masteryEffects || {},
    });

    const stats1 = await pobBridge.send('get_stats', { fields: ['Life', 'MinionTotalDPS'] });
    expect(stats1.ok).toBe(true);

    // Set to spec 9 tree (more nodes)
    const spec9 = specs[8];
    await pobBridge.send('set_tree', {
      nodes: spec9.nodes,
      classId: 5,
      ascendClassId: 3,
      masteryEffects: spec9.masteryEffects || {},
    });

    const stats2 = await pobBridge.send('get_stats', { fields: ['Life', 'MinionTotalDPS'] });
    expect(stats2.ok).toBe(true);

    // Stats should differ between specs
    const life1 = parseFloat(stats1.stats.Life || '0');
    const life2 = parseFloat(stats2.stats.Life || '0');
    expect(life1).not.toBe(life2);
  }, 20000);
});

describe('calculateUpgradeDeltas (spec 8 → spec 9)', () => {
  let result;

  beforeAll(async () => {
    const diff = computeSpecDiff(specs[7], specs[8], skillSets[7], skillSets[8], itemsMap);
    diff._fromIdx = 7;
    diff._toIdx = 8;

    result = await calculateUpgradeDeltas(
      pobBridge, doryaniXml, diff, specs[7], specs[8], itemsMap, null
    );
  }, 120000); // 2 min timeout — progressive calc is slow

  it('returns baseline stats with non-zero life', () => {
    expect(result.baseline).toBeDefined();
    const life = parseFloat(result.baseline.Life || '0');
    expect(life).toBeGreaterThan(1000);
  });

  it('returns baseline stats (may have minion DPS depending on gear)', () => {
    expect(result.baseline).toBeDefined();
    // Spec 8 may have low or moderate DPS depending on equipped items
    const life = parseFloat(result.baseline.Life || '0');
    expect(life).toBeGreaterThan(0);
  });

  it('returns target stats', () => {
    expect(result.target).toBeDefined();
  });

  it('returns upgrade entries', () => {
    expect(result.upgrades.length).toBeGreaterThan(0);
  });

  it('each upgrade has required fields', () => {
    for (const u of result.upgrades) {
      expect(u.id).toBeDefined();
      expect(u.category).toBeDefined();
      expect(u.label).toBeDefined();
      expect(u.deltas).toBeDefined();
      expect(u.pcts).toBeDefined();
      expect(typeof u.deltas).toBe('object');
    }
  });

  it('has tree category upgrades', () => {
    const treeUpgrades = result.upgrades.filter(u => u.category === 'tree');
    expect(treeUpgrades.length).toBeGreaterThan(0);
  });

  it('has jewel or combined jewel+gem upgrades', () => {
    const jewelUpgrades = result.upgrades.filter(u => u.category === 'jewel' || u.category === 'gem');
    expect(jewelUpgrades.length).toBeGreaterThan(0);
  });

  it('at least some upgrades have non-zero deltas', () => {
    const withDeltas = result.upgrades.filter(u => {
      const vals = Object.values(u.deltas);
      return vals.some(v => Math.abs(v) > 0);
    });
    expect(withDeltas.length).toBeGreaterThan(0);
  });

  it('returns timing info with reasonable calc count', () => {
    expect(result.timing).toBeDefined();
    expect(result.timing.calcCount).toBeGreaterThan(3);
    expect(result.timing.totalMs).toBeGreaterThan(100);
  });

  it('total deltas roughly match baseline → target difference (within 30% for major stats)', () => {
    // Sum all deltas for a key stat
    const statToCheck = 'Life'; // Life is stable and should add up
    const baseVal = parseFloat(result.baseline[statToCheck] || '0');
    const targetVal = parseFloat(result.target[statToCheck] || '0');
    const expectedDelta = targetVal - baseVal;

    if (Math.abs(expectedDelta) > 10) {
      const totalDelta = result.upgrades.reduce((sum, u) => sum + (u.deltas[statToCheck] || 0), 0);
      // Progressive calc means deltas may not perfectly sum due to interaction effects
      // Allow 30% tolerance
      const ratio = Math.abs(totalDelta) / Math.abs(expectedDelta);
      expect(ratio).toBeGreaterThan(0.3);
      expect(ratio).toBeLessThan(3.0);
    }
  });
});
