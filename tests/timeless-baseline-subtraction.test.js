/**
 * Integration test: validates the replacement vs addition baseline subtraction.
 *
 * BUG 3 fix: For REPLACEMENT jewels (GV/EH, resultId >= 96), the original tree
 * node stats should be SUBTRACTED from the score since you LOSE those stats.
 * For ADDITION jewels (LP/BR/MF, resultId < 96), originals are KEPT — no subtraction.
 *
 * Tests that:
 * 1. Replacement seeds have lower scores when baseline subtraction is applied
 * 2. Addition seeds are unaffected by baseline subtraction
 * 3. nodeBaselineWeights parameter correctly reduces replacement scores
 * 4. The full pipeline with baseline subtraction produces accurate predictions
 *
 * Requires: PoB headless engine (luajit) and test build in diagnostics/
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { readFileSync, existsSync } from 'fs';
import { PoBBridge } from '../pob-bridge.js';
import * as timelessDB from '../timeless-db.js';

const TEST_BUILD = 'diagnostics/test-pob-code.txt';
const HAS_BUILD = existsSync(TEST_BUILD);
const ADDITIONS_THRESHOLD = 96;
const SLOT = 'Helmet';

let bridge;
let pobCode;
let bulkWeights;
let allPassives;
let resultIdWeights;

beforeAll(async () => {
  if (!HAS_BUILD) return;
  timelessDB.initDB();
  allPassives = timelessDB.getAllLegionPassives();

  bridge = new PoBBridge();
  pobCode = readFileSync(TEST_BUILD, 'utf-8').trim();
  await bridge.loadBuild(pobCode);

  // Build bulkWeights (same as server does)
  const modLineSet = new Set();
  for (const p of allPassives) {
    if (p.is_keystone) continue;
    for (const s of (p.sd || [])) if (s?.trim()) modLineSet.add(s.trim());
  }
  const result = await bridge.calcModWeights(SLOT, [...modLineSet]);
  bulkWeights = new Map();
  if (result?.weights) {
    for (const w of result.weights) {
      bulkWeights.set(w.line, { dpsPct: w.dpsPercent || 0, ehpPct: w.ehpPercent || 0 });
    }
  }

  // Build resultIdWeights (same as server does)
  resultIdWeights = new Map();
  for (const p of allPassives) {
    if (p.is_keystone) continue;
    const resultId = p.type === 'addition' ? p.index_num : p.index_num + ADDITIONS_THRESHOLD - 1;
    let dpsPct = 0, ehpPct = 0;
    for (const s of (p.sd || [])) {
      const w = bulkWeights.get(s?.trim());
      if (w) { dpsPct += w.dpsPct; ehpPct += w.ehpPct; }
    }
    if (dpsPct !== 0 || ehpPct !== 0) {
      resultIdWeights.set(resultId, { dpsPct, ehpPct });
    }
  }
}, 120000);

afterAll(async () => {
  if (bridge) await bridge.stop().catch(() => {});
}, 10000);

// Test nodes — use nodes that exist in common jewel socket radii
const TEST_NODES = [6, 529, 544];

// =============================================================================
// Baseline subtraction: GV (replacement) vs LP (addition)
// =============================================================================

describe('baseline subtraction for replacement jewels', () => {
  it.skipIf(!HAS_BUILD)('GV (type 1, replacement) scores decrease with baseline subtraction', () => {
    // Create fake nodeBaselineWeights — simulate some original node stats
    const nodeBaselineWeights = {};
    for (const nodeId of TEST_NODES) {
      // Simulate: each node originally had +2% DPS and +1% EHP worth of stats
      nodeBaselineWeights[nodeId] = { dpsPct: 2.0, ehpPct: 1.0 };
    }

    // Get scores WITHOUT baseline subtraction
    const scoresNoBaseline = timelessDB.searchSeedsByWeight(
      1, TEST_NODES, resultIdWeights, 0.7, 0.3, 5, null
    );

    // Get scores WITH baseline subtraction
    const scoresWithBaseline = timelessDB.searchSeedsByWeight(
      1, TEST_NODES, resultIdWeights, 0.7, 0.3, 5, nodeBaselineWeights
    );

    expect(scoresNoBaseline.length).toBeGreaterThan(0);
    expect(scoresWithBaseline.length).toBeGreaterThan(0);

    // For GV (replacement jewel), baseline subtraction should lower scores
    // The top seed with baseline should have a lower score than without
    const topNoBaseline = scoresNoBaseline[0];
    const topWithBaseline = scoresWithBaseline[0];

    // Find the same seed in both results to compare
    const seedInBoth = scoresNoBaseline.find(r =>
      scoresWithBaseline.some(r2 => r2.seed === r.seed)
    );
    if (seedInBoth) {
      const withBaseline = scoresWithBaseline.find(r => r.seed === seedInBoth.seed);
      // GV transforms are ALL replacements (resultId >= 96), so baseline SHOULD be subtracted
      // The with-baseline score should be lower
      console.log(`GV seed ${seedInBoth.seed}: no_baseline=${seedInBoth.dpsPct.toFixed(2)}% dps, with_baseline=${withBaseline.dpsPct.toFixed(2)}% dps`);
      expect(withBaseline.dpsPct).toBeLessThan(seedInBoth.dpsPct);
    }
  });

  it.skipIf(!HAS_BUILD)('LP (type 2, addition) scores are unaffected by baseline subtraction', () => {
    const nodeBaselineWeights = {};
    for (const nodeId of TEST_NODES) {
      nodeBaselineWeights[nodeId] = { dpsPct: 2.0, ehpPct: 1.0 };
    }

    // LP = type 2 (addition jewel — adds stats, keeps originals)
    const scoresNoBaseline = timelessDB.searchSeedsByWeight(
      2, TEST_NODES, resultIdWeights, 0.7, 0.3, 10, null
    );

    const scoresWithBaseline = timelessDB.searchSeedsByWeight(
      2, TEST_NODES, resultIdWeights, 0.7, 0.3, 10, nodeBaselineWeights
    );

    expect(scoresNoBaseline.length).toBeGreaterThan(0);
    expect(scoresWithBaseline.length).toBeGreaterThan(0);

    // For LP, all transforms are additions (resultId < 96)
    // Baseline subtraction should NOT apply — scores should be the same
    const seedInBoth = scoresNoBaseline.find(r =>
      scoresWithBaseline.some(r2 => r2.seed === r.seed)
    );
    if (seedInBoth) {
      const withBaseline = scoresWithBaseline.find(r => r.seed === seedInBoth.seed);
      console.log(`LP seed ${seedInBoth.seed}: no_baseline=${seedInBoth.dpsPct.toFixed(2)}% dps, with_baseline=${withBaseline.dpsPct.toFixed(2)}% dps`);
      // Addition jewel scores should NOT change with baseline
      expect(withBaseline.dpsPct).toBeCloseTo(seedInBoth.dpsPct, 4);
      expect(withBaseline.ehpPct).toBeCloseTo(seedInBoth.ehpPct, 4);
    }
  });

  it.skipIf(!HAS_BUILD)('BR (type 3, addition) scores are also unaffected', () => {
    const nodeBaselineWeights = {};
    for (const nodeId of TEST_NODES) {
      nodeBaselineWeights[nodeId] = { dpsPct: 2.0, ehpPct: 1.0 };
    }

    const scoresNoBaseline = timelessDB.searchSeedsByWeight(
      3, TEST_NODES, resultIdWeights, 0.7, 0.3, 5, null
    );
    const scoresWithBaseline = timelessDB.searchSeedsByWeight(
      3, TEST_NODES, resultIdWeights, 0.7, 0.3, 5, nodeBaselineWeights
    );

    if (scoresNoBaseline.length > 0 && scoresWithBaseline.length > 0) {
      const seedInBoth = scoresNoBaseline.find(r =>
        scoresWithBaseline.some(r2 => r2.seed === r.seed)
      );
      if (seedInBoth) {
        const withBaseline = scoresWithBaseline.find(r => r.seed === seedInBoth.seed);
        expect(withBaseline.dpsPct).toBeCloseTo(seedInBoth.dpsPct, 4);
      }
    }
  });
});

// =============================================================================
// Verify transforms are correctly classified as replacement vs addition
// =============================================================================

describe('transform type classification', () => {
  it.skipIf(!HAS_BUILD)('GV (type 1) transforms are mostly replacements (resultId >= 96)', () => {
    // Get transforms for a random GV seed
    const results = timelessDB.searchSeedsByWeight(1, TEST_NODES, resultIdWeights, 0.7, 0.3, 1);
    if (results.length === 0) return;

    const transforms = timelessDB.getTransforms(1, results[0].seed, TEST_NODES);
    const replacements = transforms.filter(t => t.isReplacement);
    const additions = transforms.filter(t => !t.isReplacement);

    console.log(`GV seed ${results[0].seed}: ${replacements.length} replacements, ${additions.length} additions`);
    // GV should be mostly/all replacements
    expect(replacements.length).toBeGreaterThan(0);
  });

  it.skipIf(!HAS_BUILD)('LP (type 2) transforms are all additions (resultId < 96)', () => {
    const results = timelessDB.searchSeedsByWeight(2, TEST_NODES, resultIdWeights, 0.7, 0.3, 1);
    if (results.length === 0) return;

    const transforms = timelessDB.getTransforms(2, results[0].seed, TEST_NODES);
    const replacements = transforms.filter(t => t.isReplacement);
    const additions = transforms.filter(t => !t.isReplacement);

    console.log(`LP seed ${results[0].seed}: ${replacements.length} replacements, ${additions.length} additions`);
    // LP should be all additions (no replacements except possibly keystones)
    const nonKeystoneReplacements = replacements.filter(t => !t.isKeystone);
    expect(nonKeystoneReplacements.length).toBe(0);
  });
});

// =============================================================================
// Manual seed scoring matches DB scoring with baselines
// =============================================================================

describe('manual vs DB scoring with baselines', () => {
  it.skipIf(!HAS_BUILD)('GV manual score with subtraction matches DB score', () => {
    // Create realistic baseline weights by using bulkWeights
    const nodeBaselineWeights = {};
    // Simulate: each node had some stat that's worth weight
    for (const nodeId of TEST_NODES) {
      // Give each node a small baseline (as if it had "+20% increased Damage")
      const dmgWeight = bulkWeights.get('20% increased Physical Damage');
      if (dmgWeight) {
        nodeBaselineWeights[nodeId] = { dpsPct: dmgWeight.dpsPct, ehpPct: dmgWeight.ehpPct };
      } else {
        nodeBaselineWeights[nodeId] = { dpsPct: 0.5, ehpPct: 0.2 };
      }
    }

    const dbResults = timelessDB.searchSeedsByWeight(
      1, TEST_NODES, resultIdWeights, 0.7, 0.3, 1, nodeBaselineWeights
    );
    if (dbResults.length === 0) return;

    const topSeed = dbResults[0].seed;
    const transforms = timelessDB.getTransforms(1, topSeed, TEST_NODES);

    // Manual calculation with baseline subtraction
    let manualDpsPct = 0, manualEhpPct = 0;
    for (const t of transforms) {
      if (t.isKeystone) continue;
      // Add transform weight
      for (const s of (t.sd || [])) {
        const w = bulkWeights.get(s?.trim());
        if (w) { manualDpsPct += w.dpsPct; manualEhpPct += w.ehpPct; }
      }
      // Subtract baseline for replacements only
      if (t.isReplacement) {
        const baseline = nodeBaselineWeights[t.nodeId];
        if (baseline) {
          manualDpsPct -= baseline.dpsPct;
          manualEhpPct -= baseline.ehpPct;
        }
      }
    }

    console.log(`GV seed ${topSeed}: DB dpsPct=${dbResults[0].dpsPct.toFixed(4)}, manual=${manualDpsPct.toFixed(4)}`);
    expect(Math.abs(dbResults[0].dpsPct - manualDpsPct)).toBeLessThan(0.01);
    expect(Math.abs(dbResults[0].ehpPct - manualEhpPct)).toBeLessThan(0.01);
  });
});
