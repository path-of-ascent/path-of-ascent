/**
 * Upgrade Planner — computes spec diffs and calculates DPS/EHP deltas via PoB bridge.
 */

const STAT_FIELDS = [
  'Life', 'EnergyShield', 'TotalEHP', 'Armour', 'Evasion',
  'FireResist', 'ColdResist', 'LightningResist', 'ChaosResist',
  'BlockChance', 'SpellBlockChance', 'PhysicalDamageReduction',
  'MinionTotalDPS', 'MinionCombinedDPS', 'MinionLife', 'MinionEnergyShield',
  'MinionArmour', 'MinionFireResist', 'MinionColdResist', 'MinionLightningResist',
  'MinionChaosResist',
];

/**
 * Compute the diff between two specs.
 * Returns categorized changes: tree nodes, jewels, gems, masteries.
 */
export function computeSpecDiff(fromSpec, toSpec, fromSkills, toSkills, itemsMap) {
  // --- Tree node diff ---
  const fromNodes = new Set(fromSpec.nodes);
  const toNodes = new Set(toSpec.nodes);
  const addedNodes = toSpec.nodes.filter(n => !fromNodes.has(n));
  const removedNodes = fromSpec.nodes.filter(n => !toNodes.has(n));

  // --- Mastery diff ---
  const masteryChanges = [];
  const allMasteryNodes = new Set([
    ...Object.keys(fromSpec.masteryEffects || {}),
    ...Object.keys(toSpec.masteryEffects || {}),
  ]);
  for (const nodeId of allMasteryNodes) {
    const fromEffect = (fromSpec.masteryEffects || {})[nodeId];
    const toEffect = (toSpec.masteryEffects || {})[nodeId];
    if (fromEffect !== toEffect) {
      masteryChanges.push({
        nodeId: parseInt(nodeId),
        fromEffect: fromEffect || null,
        toEffect: toEffect || null,
        type: !fromEffect ? 'added' : !toEffect ? 'removed' : 'changed',
      });
    }
  }

  // --- Jewel diff ---
  const jewelChanges = [];
  const allJewelNodes = new Set([
    ...Object.keys(fromSpec.jewelSockets || {}),
    ...Object.keys(toSpec.jewelSockets || {}),
  ]);
  for (const nodeId of allJewelNodes) {
    const fromItemId = (fromSpec.jewelSockets || {})[nodeId];
    const toItemId = (toSpec.jewelSockets || {})[nodeId];
    if (fromItemId === toItemId) continue;

    const fromText = fromItemId ? (itemsMap[fromItemId] || null) : null;
    const toText = toItemId ? (itemsMap[toItemId] || null) : null;

    let type;
    if (!fromItemId && toItemId) type = 'added';
    else if (fromItemId && !toItemId) type = 'removed';
    else type = 'swapped';

    jewelChanges.push({
      nodeId,
      type,
      fromItemId: fromItemId || null,
      toItemId: toItemId || null,
      fromName: fromText ? extractItemName(fromText) : null,
      toName: toText ? extractItemName(toText) : null,
      toItemText: toText,
    });
  }

  // --- Gem diff ---
  const gemChanges = computeGemDiff(fromSkills || [], toSkills || []);

  return { addedNodes, removedNodes, masteryChanges, jewelChanges, gemChanges, _fromIdx: null, _toIdx: null };
}

/**
 * Compute gem link differences between two skill sets.
 */
function computeGemDiff(fromSkills, toSkills) {
  const changes = [];

  // Index skills by slot
  const fromBySlot = {};
  for (const s of fromSkills) {
    if (s.enabled && s.slot) fromBySlot[s.slot] = s;
  }
  const toBySlot = {};
  for (const s of toSkills) {
    if (s.enabled && s.slot) toBySlot[s.slot] = s;
  }

  const allSlots = new Set([...Object.keys(fromBySlot), ...Object.keys(toBySlot)]);

  for (const slot of allSlots) {
    const fromGroup = fromBySlot[slot];
    const toGroup = toBySlot[slot];

    if (!fromGroup && toGroup) {
      changes.push({
        slot,
        type: 'new_group',
        description: `New skill group in ${slot}`,
        toGems: toGroup.gems.map(g => ({ name: g.name, level: g.level, quality: g.quality })),
        fromGems: [],
      });
      continue;
    }
    if (fromGroup && !toGroup) {
      changes.push({
        slot,
        type: 'removed_group',
        description: `Removed skill group from ${slot}`,
        fromGems: fromGroup.gems.map(g => ({ name: g.name, level: g.level, quality: g.quality })),
        toGems: [],
      });
      continue;
    }
    if (!fromGroup || !toGroup) continue;

    // Compare gem lists
    const fromNames = new Set(fromGroup.gems.filter(g => g.enabled !== false).map(g => g.name));
    const toNames = new Set(toGroup.gems.filter(g => g.enabled !== false).map(g => g.name));

    const added = [...toNames].filter(n => !fromNames.has(n));
    const removed = [...fromNames].filter(n => !toNames.has(n));

    if (added.length > 0 || removed.length > 0) {
      const parts = [];
      if (added.length > 0) parts.push(`+${added.join(', +')}`);
      if (removed.length > 0) parts.push(`-${removed.join(', -')}`);

      changes.push({
        slot,
        type: 'modified',
        description: `${slot}: ${parts.join('; ')}`,
        added,
        removed,
        fromGems: fromGroup.gems.map(g => ({ name: g.name, level: g.level, quality: g.quality })),
        toGems: toGroup.gems.map(g => ({ name: g.name, level: g.level, quality: g.quality })),
      });
    }
  }

  return changes;
}

/**
 * Group tree node changes for efficient calc_with calls.
 * Keystones get individual groups. Notables grouped with adjacent small passives.
 * Requires GGG tree data for node classification.
 */
export function groupTreeChanges(addedNodes, removedNodes, treeData) {
  if (!treeData || !treeData.nodes) {
    // Fallback: all added nodes as one group, all removed as one group
    const groups = [];
    if (addedNodes.length > 0) {
      groups.push({ label: `${addedNodes.length} tree nodes`, category: 'pathing', addNodes: addedNodes, removeNodes: [] });
    }
    if (removedNodes.length > 0) {
      groups.push({ label: `${removedNodes.length} removed nodes`, category: 'removed', addNodes: [], removeNodes: removedNodes });
    }
    return groups;
  }

  const nodes = treeData.nodes;
  const groups = [];
  const addedSet = new Set(addedNodes.map(String));
  const claimed = new Set();

  // 1. Keystones — each gets its own group
  for (const nodeId of addedNodes) {
    const node = nodes[String(nodeId)];
    if (node?.isKeystone) {
      groups.push({
        label: node.name || `Keystone ${nodeId}`,
        category: 'keystone',
        addNodes: [nodeId],
        removeNodes: [],
      });
      claimed.add(String(nodeId));
    }
  }

  // 2. Notables — each gets grouped with unclaimed adjacent small passives
  for (const nodeId of addedNodes) {
    const nStr = String(nodeId);
    if (claimed.has(nStr)) continue;
    const node = nodes[nStr];
    if (!node?.isNotable) continue;

    const groupNodes = [nodeId];
    claimed.add(nStr);

    // Find adjacent small passives that are also in addedNodes
    const queue = [nStr];
    const visited = new Set([nStr]);
    while (queue.length > 0) {
      const current = queue.shift();
      const cNode = nodes[current];
      if (!cNode) continue;
      for (const outId of (cNode.out || [])) {
        const outStr = String(outId);
        if (visited.has(outStr)) continue;
        visited.add(outStr);
        if (!addedSet.has(outStr) || claimed.has(outStr)) continue;
        const outNode = nodes[outStr];
        if (outNode && !outNode.isKeystone && !outNode.isNotable && !outNode.ascendancyName) {
          groupNodes.push(parseInt(outId));
          claimed.add(outStr);
          queue.push(outStr);
        }
      }
    }

    groups.push({
      label: node.name || `Notable ${nodeId}`,
      category: 'notable',
      addNodes: groupNodes,
      removeNodes: [],
    });
  }

  // 3. Remaining unclaimed small passives — group together
  const remaining = addedNodes.filter(n => !claimed.has(String(n)));
  if (remaining.length > 0) {
    groups.push({
      label: `${remaining.length} pathing nodes`,
      category: 'pathing',
      addNodes: remaining,
      removeNodes: [],
    });
  }

  // 4. Removed nodes — one group
  if (removedNodes.length > 0) {
    groups.push({
      label: `${removedNodes.length} removed nodes`,
      category: 'removed',
      addNodes: [],
      removeNodes: removedNodes,
    });
  }

  return groups;
}

/**
 * Calculate DPS/EHP deltas for all upgrades via PoB bridge.
 * Progressive strategy: tree changes (non-destructive), then jewels, then gems.
 */
// Cache GGG tree data
let _cachedTreeData = null;
async function fetchTreeData() {
  if (_cachedTreeData) return _cachedTreeData;
  try {
    const resp = await fetch('https://raw.githubusercontent.com/grindinggear/skilltree-export/master/data.json');
    if (resp.ok) _cachedTreeData = await resp.json();
  } catch {}
  return _cachedTreeData;
}

export async function calculateUpgradeDeltas(bridge, pobXml, diff, fromSpec, toSpec, itemsMap, treeData, onProgress) {
  const progress = onProgress || (() => {});
  const upgrades = [];
  let calcCount = 0;
  const startTime = Date.now();

  // Fetch tree data for node grouping if not provided
  if (!treeData) {
    progress('Fetching tree data...');
    treeData = await fetchTreeData();
  }

  const buildInfo = parseBuildInfoFromXml(pobXml);

  // Strategy: modify the XML's active indices and reload to get accurate stats.
  // PoB couples spec, item set, and skill set — the only reliable way to get correct
  // stats for a given spec is to load the build with that spec active.

  // Helper: reload build with a specific spec/itemset/skillset active
  async function loadWithSpec(specIdx) {
    // PoB uses 1-indexed spec/itemset/skillset
    const idx1 = specIdx + 1;
    let modXml = pobXml
      .replace(/activeSpec="\d+"/, `activeSpec="${idx1}"`)
      .replace(/activeSkillSet="\d+"/, `activeSkillSet="${idx1}"`)
      .replace(/activeItemSet="\d+"/, `activeItemSet="${idx1}"`);
    await bridge.send('load_build_xml', { xml: modXml, name: 'Upgrade Planner' });
    const res = await bridge.send('get_stats', { fields: STAT_FIELDS });
    calcCount++;
    return res.ok ? res.stats : null;
  }

  // 1. Get from-spec baseline
  progress('Loading from-spec...');
  const baseline = await loadWithSpec(diff._fromIdx ?? 0);
  if (!baseline) throw new Error('Failed to get baseline stats');

  // 2. Get to-spec target
  progress('Loading to-spec...');
  const target = await loadWithSpec(diff._toIdx ?? 0);

  // 3. Tree groups — compute deltas by loading from-spec then adding node groups
  progress('Analyzing tree changes...');
  // Reload from-spec as base
  const fromIdx1 = (diff._fromIdx ?? 0) + 1;
  let modXml = pobXml
    .replace(/activeSpec="\d+"/, `activeSpec="${fromIdx1}"`)
    .replace(/activeSkillSet="\d+"/, `activeSkillSet="${fromIdx1}"`)
    .replace(/activeItemSet="\d+"/, `activeItemSet="${fromIdx1}"`);
  await bridge.send('load_build_xml', { xml: modXml, name: 'Upgrade Planner' });

  const treeGroups = groupTreeChanges(diff.addedNodes, diff.removedNodes, treeData);
  const currentNodeSet = new Set(fromSpec.nodes.map(String));
  // Include jewel socket nodes
  for (const nodeId of Object.keys(fromSpec.jewelSockets || {})) {
    currentNodeSet.add(nodeId);
  }

  for (let i = 0; i < treeGroups.length; i++) {
    const group = treeGroups[i];
    progress(`Tree: ${group.label} (${i + 1}/${treeGroups.length})`);

    const beforeRes = await bridge.send('get_stats', { fields: STAT_FIELDS });
    const beforeStats = beforeRes.ok ? beforeRes.stats : baseline;

    for (const n of group.addNodes) currentNodeSet.add(String(n));
    for (const n of group.removeNodes) currentNodeSet.delete(String(n));

    await bridge.send('set_tree', {
      nodes: [...currentNodeSet].map(Number),
      classId: buildInfo.classId,
      ascendClassId: fromSpec.ascendClassId || buildInfo.ascendClassId,
      masteryEffects: fromSpec.masteryEffects || {},
    });

    const afterRes = await bridge.send('get_stats', { fields: STAT_FIELDS });
    calcCount += 2;

    if (afterRes.ok) {
      const deltas = computeDeltas(afterRes.stats, beforeStats);
      const pcts = computePcts(deltas, beforeStats);
      if (Object.keys(deltas).length > 0) {
        upgrades.push({
          id: `tree-${group.category}-${i}`,
          category: 'tree',
          subcategory: group.category,
          label: group.label,
          description: `Tree: ${group.label} (${group.addNodes.length} nodes)`,
          details: { nodeIds: group.addNodes, removeNodeIds: group.removeNodes },
          deltas,
          pcts,
        });
      }
    }
  }

  // 4. Jewel + gem changes — compute combined delta (tree changes vs full spec change)
  if (baseline && target) {
    progress('Analyzing jewel & gem changes...');

    // Overall delta from→to
    const overallDeltas = computeDeltas(target, baseline);

    // Sum tree-only deltas
    const treeOnlyDeltas = {};
    for (const u of upgrades) {
      for (const [k, v] of Object.entries(u.deltas)) {
        treeOnlyDeltas[k] = (treeOnlyDeltas[k] || 0) + v;
      }
    }

    // Remaining = jewels + gems + items
    const remainingDeltas = {};
    for (const [k, v] of Object.entries(overallDeltas)) {
      const treePart = treeOnlyDeltas[k] || 0;
      const remainder = v - treePart;
      if (Math.abs(remainder) > 0.5) {
        remainingDeltas[k] = Math.round(remainder * 100) / 100;
      }
    }

    // Try to isolate gem-only delta (to-spec tree+items with from-spec skills)
    let gemDeltas = null;
    if (diff.gemChanges.length > 0) {
      const toIdx1 = (diff._toIdx ?? 0) + 1;
      const fromIdx1 = (diff._fromIdx ?? 0) + 1;
      const gemBaseXml = pobXml
        .replace(/activeSpec="\d+"/, `activeSpec="${toIdx1}"`)
        .replace(/activeSkillSet="\d+"/, `activeSkillSet="${fromIdx1}"`)
        .replace(/activeItemSet="\d+"/, `activeItemSet="${toIdx1}"`);

      await bridge.send('load_build_xml', { xml: gemBaseXml, name: 'Gem Base' });
      const gemBaseStats = await bridge.send('get_stats', { fields: STAT_FIELDS });
      calcCount++;

      if (gemBaseStats.ok) {
        gemDeltas = computeDeltas(target, gemBaseStats.stats);
      }
    }

    // Jewel-only delta = remaining - gems
    const jewelDeltas = { ...remainingDeltas };
    if (gemDeltas) {
      for (const [k, v] of Object.entries(gemDeltas)) {
        if (jewelDeltas[k] !== undefined) {
          jewelDeltas[k] = Math.round((jewelDeltas[k] - v) * 100) / 100;
          if (Math.abs(jewelDeltas[k]) < 0.5) delete jewelDeltas[k];
        }
      }
    }

    // Add combined jewel entry with total jewel delta
    const effectiveJewelDeltas = Object.keys(jewelDeltas).length > 0 ? jewelDeltas : remainingDeltas;
    if (diff.jewelChanges.length > 0) {
      const jewelPcts = computePcts(effectiveJewelDeltas, baseline);
      upgrades.push({
        id: 'jewels-combined',
        category: 'jewel',
        subcategory: 'total',
        label: `All jewels (${diff.jewelChanges.length} changes)`,
        description: diff.jewelChanges.map(jc =>
          jc.type === 'swapped' ? `${jc.fromName} → ${jc.toName}` : `+ ${jc.toName}`
        ).join(', '),
        details: { changes: diff.jewelChanges.map(jc => ({ nodeId: jc.nodeId, from: jc.fromName, to: jc.toName, type: jc.type })) },
        deltas: effectiveJewelDeltas,
        pcts: jewelPcts,
      });

      // List individual jewels with their stat lines (for reference)
      for (const jc of diff.jewelChanges) {
        if (jc.type === 'removed') continue;
        const statLines = jc.toItemText ? extractJewelStatLines(jc.toItemText) : [];
        upgrades.push({
          id: `jewel-${jc.nodeId}`,
          category: 'jewel',
          label: jc.toName || 'Unknown Jewel',
          description: jc.type === 'swapped'
            ? `Replace ${jc.fromName} with ${jc.toName}`
            : `Add ${jc.toName}`,
          details: {
            nodeId: jc.nodeId,
            fromItem: jc.fromName,
            toItem: jc.toName,
            stats: statLines,
          },
          deltas: {},
          pcts: {},
        });
      }
    }

    // Add individual gem changes with their measured deltas
    if (diff.gemChanges.length > 0 && gemDeltas) {
      const gemPcts = computePcts(gemDeltas, baseline);
      upgrades.push({
        id: 'gems-combined',
        category: 'gem',
        subcategory: 'total',
        label: `All gem swaps (${diff.gemChanges.length} changes)`,
        description: diff.gemChanges.map(gc => gc.description || gc.slot).join(', '),
        details: { changes: diff.gemChanges },
        deltas: gemDeltas,
        pcts: gemPcts,
      });

      // Also list individual gem changes for reference
      for (const gc of diff.gemChanges) {
        upgrades.push({
          id: `gem-${gc.slot.replace(/\s+/g, '-').toLowerCase()}`,
          category: 'gem',
          label: gc.description || `${gc.slot} gem changes`,
          description: gc.description || `Gem changes in ${gc.slot}`,
          details: { slot: gc.slot, added: gc.added, removed: gc.removed },
          deltas: {},
          pcts: {},
        });
      }
    }
  }

  return {
    baseline,
    target,
    upgrades,
    timing: { totalMs: Date.now() - startTime, calcCount },
  };
}

// --- Helpers ---

function extractJewelStatLines(rawText) {
  const lines = rawText.split('\n').map(l => l.trim()).filter(l => l);
  const stats = [];

  // Find selected variant(s)
  const activeVariants = new Set();
  for (const line of lines) {
    const sv = line.match(/^Selected Variant:\s*(\d+)/);
    if (sv) activeVariants.add(sv[1]);
  }

  const skip = /^(Rarity|Unique ID|Item Level|LevelReq|Implicits|Variant|Selected Variant|Selected Alt Variant|Has Alt Variant|League|Crafted|Prefix|Suffix|Limited|Radius|Cluster Jewel|Catalyst|CatalystQuality|Abyss|Sockets|Source|ArmourBasePercentile|EnergyShieldBasePercentile|Armour|Energy Shield|Evasion|Quality|Adds \d+ Passive|Added Small Passive Skills grant|CatalystQuality):/;
  const skipExact = /^(Corrupted|Historic|Abyss|Has Alt Variant.*|Selected Alt Variant.*)$/;

  for (const line of lines.slice(2)) { // skip rarity + name
    if (skip.test(line)) continue;
    if (skipExact.test(line)) continue;

    // Filter variant-tagged lines: only include if variant matches selected
    const variantMatch = line.match(/\{variant:(\d+)\}/);
    if (variantMatch && activeVariants.size > 0 && !activeVariants.has(variantMatch[1])) continue;

    // Clean variant/crafted tags
    const clean = line.replace(/\{[^}]*\}/g, '').trim();
    // Skip base type and jewel type lines
    if (/^(Cobalt|Crimson|Viridian|Prismatic|Timeless|Ghastly|Murderous|Searching|Hypnotic|Large Cluster|Medium Cluster|Small Cluster|Onyx|Ruby|Sapphire|Topaz|Two-Stone|Unset)/.test(clean)) continue;
    // Skip remaining metadata (keep "1 Added Passive Skill is X" for cluster notables)
    if (/^(Limited to|Adds \d+ Passive Skills$|Added Small Passive Skills|Cluster Jewel|Has \d|Node Count|\d+ Added Passive Skills are Jewel)/.test(clean)) continue;
    if (clean.length > 2) {
      stats.push(clean);
    }
  }
  return stats;
}

function extractItemName(rawText) {
  const lines = rawText.split('\n').map(l => l.trim()).filter(l => l);
  // Line 0: Rarity: X, Line 1: name (for unique/rare), or line 1 is the base type
  if (lines.length < 2) return lines[0] || 'Unknown';
  const rarity = lines[0].match(/Rarity:\s*(\w+)/);
  if (rarity && ['UNIQUE', 'RARE'].includes(rarity[1].toUpperCase())) {
    return lines[1]; // item name
  }
  return lines[1]; // base type for normal/magic
}

function computeDeltas(output, baseline) {
  const deltas = {};
  for (const field of STAT_FIELDS) {
    const outVal = getStatValue(output, field);
    const baseVal = getStatValue(baseline, field);
    if (outVal !== undefined && baseVal !== undefined) {
      const delta = outVal - baseVal;
      if (Math.abs(delta) > 0.01) {
        deltas[field] = Math.round(delta * 100) / 100;
      }
    }
  }
  return deltas;
}

function computePcts(deltas, baseline) {
  const pcts = {};
  for (const [field, delta] of Object.entries(deltas)) {
    const baseVal = getStatValue(baseline, field);
    if (baseVal && Math.abs(baseVal) > 0.01) {
      pcts[field] = Math.round((delta / Math.abs(baseVal)) * 1000) / 10;
    }
  }
  return pcts;
}

function getStatValue(stats, field) {
  if (!stats) return undefined;
  // Stats from get_stats may be nested or flat
  if (stats[field] !== undefined) return parseFloat(stats[field]);
  // Check _meta sub-object
  if (stats._meta && stats._meta[field] !== undefined) return parseFloat(stats._meta[field]);
  return undefined;
}

function parseBuildInfoFromXml(xml) {
  const CLASS_IDS = {
    Scion: 0, Marauder: 1, Ranger: 2, Witch: 3, Duelist: 4, Templar: 5, Shadow: 6,
  };
  const ASCENDANCY_IDS = {
    Ascendant: 1, Juggernaut: 1, Berserker: 2, Chieftain: 3,
    Raider: 1, Deadeye: 2, Pathfinder: 3,
    Occultist: 1, Elementalist: 2, Necromancer: 3,
    Slayer: 1, Gladiator: 2, Champion: 3,
    Inquisitor: 1, Hierophant: 2, Guardian: 3,
    Assassin: 1, Trickster: 2, Saboteur: 3,
  };

  const buildMatch = xml.match(/<Build\s([^>]*)>/);
  if (!buildMatch) return { classId: 0, ascendClassId: 0 };
  const attrs = buildMatch[1];
  const className = (attrs.match(/className="([^"]+)"/) || [])[1] || '';
  const ascendClassName = (attrs.match(/ascendClassName="([^"]+)"/) || [])[1] || '';

  return {
    classId: CLASS_IDS[className] || 0,
    ascendClassId: ASCENDANCY_IDS[ascendClassName] || 0,
  };
}
