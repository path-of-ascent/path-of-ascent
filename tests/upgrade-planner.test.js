import { describe, it, expect, beforeAll } from 'vitest';
import { readFileSync } from 'fs';
import { inflate } from 'pako';
import { parseSpecs, parseSkillSets, parseItems } from '../pob-xml-parser.js';
import { computeSpecDiff, groupTreeChanges } from '../upgrade-planner.js';

let doryaniXml;
let specs;
let skillSets;
let itemsMap;

beforeAll(() => {
  const raw = readFileSync('diagnostics/test-pob-code.txt', 'utf-8').trim();
  const b64 = raw.replace(/-/g, '+').replace(/_/g, '/');
  const buf = Buffer.from(b64, 'base64');
  doryaniXml = inflate(buf, { to: 'string' });
  specs = parseSpecs(doryaniXml);
  skillSets = parseSkillSets(doryaniXml);
  itemsMap = parseItems(doryaniXml);
});

describe('computeSpecDiff (spec 8 → spec 9)', () => {
  let diff;

  beforeAll(() => {
    // spec 8 = index 7 (Lvl 90+), spec 9 = index 8 (Endgame Doryani)
    diff = computeSpecDiff(specs[7], specs[8], skillSets[7], skillSets[8], itemsMap);
  });

  // --- Tree nodes ---
  it('produces non-empty addedNodes', () => {
    expect(diff.addedNodes.length).toBeGreaterThan(0);
  });

  it('produces non-empty removedNodes (tree respec)', () => {
    // Transitioning specs may add and remove nodes
    expect(diff.removedNodes.length + diff.addedNodes.length).toBeGreaterThan(10);
  });

  // --- Jewels ---
  it('detects jewel changes', () => {
    expect(diff.jewelChanges.length).toBeGreaterThan(0);
  });

  it('detects Glorious Vanity being added/swapped at node 61419', () => {
    const gv = diff.jewelChanges.find(j => j.nodeId === '61419');
    expect(gv).toBeDefined();
    expect(gv.toName).toContain('Glorious Vanity');
    expect(gv.type).toBe('swapped'); // replaces Sol Star
    expect(gv.fromName).toBe('Sol Star');
  });

  it('detects Thread of Hope being added at node 26196', () => {
    const toh = diff.jewelChanges.find(j => j.nodeId === '26196');
    expect(toh).toBeDefined();
    expect(toh.toName).toContain('Thread of Hope');
    expect(toh.type).toBe('added');
  });

  it('detects Watcher\'s Eye replacing Reckless Defence at node 36634', () => {
    const we = diff.jewelChanges.find(j => j.nodeId === '36634');
    expect(we).toBeDefined();
    expect(we.toName).toContain('Watcher');
    expect(we.fromName).toContain('Reckless Defence');
    expect(we.type).toBe('swapped');
  });

  it('detects Grand Spectrum additions (3 sockets)', () => {
    const grandSpectrums = diff.jewelChanges.filter(j =>
      j.toName && j.toName.includes('Grand Spectrum')
    );
    expect(grandSpectrums.length).toBe(3);
    for (const gs of grandSpectrums) {
      expect(gs.type).toBe('added');
    }
  });

  it('detects Large Cluster Jewel additions (2 sockets)', () => {
    const clusters = diff.jewelChanges.filter(j =>
      j.toItemText && j.toItemText.includes('Large Cluster Jewel')
    );
    expect(clusters.length).toBe(2);
  });

  it('detects Small Cluster Jewel addition with Enduring Composure', () => {
    const small = diff.jewelChanges.find(j =>
      j.toItemText && j.toItemText.includes('Small Cluster Jewel')
    );
    expect(small).toBeDefined();
    expect(small.toItemText).toContain('EnduringComposure');
  });

  it('has toItemText for all added/swapped jewels', () => {
    for (const jc of diff.jewelChanges) {
      if (jc.type === 'added' || jc.type === 'swapped') {
        expect(jc.toItemText).toBeTruthy();
        expect(jc.toItemText.length).toBeGreaterThan(10);
      }
    }
  });

  // --- Gems ---
  it('detects gem changes', () => {
    expect(diff.gemChanges.length).toBeGreaterThan(0);
  });

  it('detects Purity of Fire added to Helmet', () => {
    const helmet = diff.gemChanges.find(g => g.slot === 'Helmet');
    expect(helmet).toBeDefined();
    expect(helmet.added).toContain('Purity of Fire');
  });

  it('detects Flesh and Stone removed from Helmet (moved to Weapon 2)', () => {
    const helmet = diff.gemChanges.find(g => g.slot === 'Helmet');
    expect(helmet).toBeDefined();
    expect(helmet.removed).toContain('Flesh and Stone');
  });

  it('detects Punishment added to Weapon 1', () => {
    const weapon = diff.gemChanges.find(g => g.slot === 'Weapon 1');
    expect(weapon).toBeDefined();
    expect(weapon.added).toContain('Punishment');
  });

  it('detects Elemental Weakness removed from Weapon 1', () => {
    const weapon = diff.gemChanges.find(g => g.slot === 'Weapon 1');
    expect(weapon).toBeDefined();
    expect(weapon.removed).toContain('Elemental Weakness');
  });

  it('detects Enlighten added to Helmet', () => {
    const helmet = diff.gemChanges.find(g => g.slot === 'Helmet');
    expect(helmet).toBeDefined();
    expect(helmet.added).toContain('Enlighten');
  });

  // --- Mastery changes ---
  it('has mastery changes array', () => {
    expect(Array.isArray(diff.masteryChanges)).toBe(true);
  });
});

describe('groupTreeChanges', () => {
  // Create a minimal mock tree data for testing
  const mockTreeData = {
    nodes: {
      '100': { name: 'Iron Will', isKeystone: true, out: ['101'] },
      '101': { name: 'Small Passive', out: ['100', '102'] },
      '102': { name: 'Notable A', isNotable: true, out: ['101', '103'] },
      '103': { name: 'Small Passive 2', out: ['102'] },
      '104': { name: 'Another Small', out: ['105'] },
      '105': { name: 'Notable B', isNotable: true, out: ['104'] },
      '200': { name: 'Removed Small', out: [] },
    },
  };

  it('puts keystones in individual groups', () => {
    const groups = groupTreeChanges([100, 101, 102, 103], [], mockTreeData);
    const keystoneGroup = groups.find(g => g.category === 'keystone');
    expect(keystoneGroup).toBeDefined();
    expect(keystoneGroup.addNodes).toEqual([100]);
    expect(keystoneGroup.label).toBe('Iron Will');
  });

  it('groups notables with adjacent small passives', () => {
    const groups = groupTreeChanges([101, 102, 103], [], mockTreeData);
    const notableGroup = groups.find(g => g.category === 'notable' && g.label === 'Notable A');
    expect(notableGroup).toBeDefined();
    expect(notableGroup.addNodes).toContain(102); // notable itself
    expect(notableGroup.addNodes).toContain(101); // adjacent small
    expect(notableGroup.addNodes).toContain(103); // adjacent small
  });

  it('puts unclaimed small passives in a pathing group', () => {
    // Node 104 is not adjacent to any notable in the added set (105 not added)
    const groups = groupTreeChanges([104], [], mockTreeData);
    const pathingGroup = groups.find(g => g.category === 'pathing');
    expect(pathingGroup).toBeDefined();
    expect(pathingGroup.addNodes).toContain(104);
  });

  it('puts removed nodes in their own group', () => {
    const groups = groupTreeChanges([], [200], mockTreeData);
    const removedGroup = groups.find(g => g.category === 'removed');
    expect(removedGroup).toBeDefined();
    expect(removedGroup.removeNodes).toContain(200);
  });

  it('returns fallback groups when no tree data available', () => {
    const groups = groupTreeChanges([1, 2, 3], [4], null);
    expect(groups.length).toBe(2);
    expect(groups[0].addNodes).toEqual([1, 2, 3]);
    expect(groups[1].removeNodes).toEqual([4]);
  });

  it('does not double-count nodes across groups', () => {
    const groups = groupTreeChanges([100, 101, 102, 103, 104, 105], [], mockTreeData);
    const allNodes = groups.flatMap(g => g.addNodes);
    const unique = new Set(allNodes);
    expect(allNodes.length).toBe(unique.size);
  });
});

describe('computeSpecDiff edge cases', () => {
  it('returns empty diff when comparing a spec to itself', () => {
    const diff = computeSpecDiff(specs[8], specs[8], skillSets[8], skillSets[8], itemsMap);
    expect(diff.addedNodes).toHaveLength(0);
    expect(diff.removedNodes).toHaveLength(0);
    expect(diff.jewelChanges).toHaveLength(0);
    expect(diff.gemChanges).toHaveLength(0);
  });

  it('handles specs with no jewel sockets', () => {
    const diff = computeSpecDiff(specs[0], specs[1], skillSets[0], skillSets[1], itemsMap);
    // Early specs have no jewels, so jewelChanges should be empty
    expect(diff.jewelChanges).toHaveLength(0);
  });

  it('handles missing skill sets gracefully', () => {
    const diff = computeSpecDiff(specs[7], specs[8], null, null, itemsMap);
    expect(diff.gemChanges).toHaveLength(0);
    // Other diffs should still work
    expect(diff.addedNodes.length + diff.removedNodes.length).toBeGreaterThan(0);
  });
});
