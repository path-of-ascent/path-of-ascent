import { useEffect, useRef, useState, useCallback, useMemo } from 'react';

const TREE_DATA_URL = 'https://raw.githubusercontent.com/grindinggear/skilltree-export/master/data.json';

let cachedTreeData = null;
let cachedPositions = null;

async function fetchTreeData() {
  if (cachedTreeData) return cachedTreeData;
  const res = await fetch(TREE_DATA_URL);
  if (!res.ok) throw new Error('Failed to fetch tree data');
  cachedTreeData = await res.json();
  return cachedTreeData;
}

function computeAllPositions(treeData) {
  if (cachedPositions) return cachedPositions;
  const { nodes, groups, constants } = treeData;
  const { orbitRadii, skillsPerOrbit } = constants;
  const positions = {};

  for (const [id, node] of Object.entries(nodes)) {
    const group = groups[node.group];
    if (!group) continue;
    if (node.orbit === 0) {
      positions[id] = { x: group.x, y: group.y };
    } else {
      const radius = orbitRadii[node.orbit] || 0;
      const total = skillsPerOrbit[node.orbit] || 1;
      const angle = (2 * Math.PI * node.orbitIndex) / total - Math.PI / 2;
      positions[id] = {
        x: group.x + radius * Math.cos(angle),
        y: group.y + radius * Math.sin(angle),
      };
    }
  }
  cachedPositions = positions;
  return positions;
}

export function decodeTreeUrl(url) {
  const parts = url.replace(/\s+/g, '').split('/');
  const hash = parts[parts.length - 1];
  if (!hash || hash.length < 4) return null;
  try {
    const b64 = hash.replace(/-/g, '+').replace(/_/g, '/');
    const raw = atob(b64);
    const bytes = new Uint8Array(raw.length);
    for (let i = 0; i < raw.length; i++) bytes[i] = raw.charCodeAt(i);
    const ver = (bytes[0] << 24) | (bytes[1] << 16) | (bytes[2] << 8) | bytes[3];
    let offset = ver >= 4 ? 7 : 6;
    const nodes = new Set();
    while (offset + 1 < bytes.length) {
      const nodeId = (bytes[offset] << 8) | bytes[offset + 1];
      if (nodeId > 0) nodes.add(String(nodeId));
      offset += 2;
    }
    return { nodes };
  } catch {
    return null;
  }
}

const ASCENDANCY_BY_CLASS = {
  0: ['Ascendant'],
  1: ['Juggernaut', 'Berserker', 'Chieftain'],
  2: ['Deadeye', 'Raider', 'Pathfinder'],
  3: ['Elementalist', 'Necromancer', 'Occultist'],
  4: ['Slayer', 'Gladiator', 'Champion'],
  5: ['Inquisitor', 'Hierophant', 'Guardian'],
  6: ['Assassin', 'Saboteur', 'Trickster'],
};

// --- Label collision avoidance ---
function resolveLabels(rawLabels, maxIter = 30) {
  // Sort by priority: keystones first, then notables
  const labels = rawLabels.map(l => ({ ...l, dispX: l.x, dispY: l.y - l.r - 4 }));
  const PAD_X = 4;
  const PAD_Y = 2;

  for (let iter = 0; iter < maxIter; iter++) {
    let moved = false;
    for (let i = 0; i < labels.length; i++) {
      for (let j = i + 1; j < labels.length; j++) {
        const a = labels[i];
        const b = labels[j];
        const overlapX = (a.w / 2 + b.w / 2 + PAD_X) - Math.abs(a.dispX - b.dispX);
        const overlapY = (a.h / 2 + b.h / 2 + PAD_Y) - Math.abs(a.dispY - b.dispY);
        if (overlapX > 0 && overlapY > 0) {
          // Push apart vertically (cheaper than horizontal)
          const pushY = overlapY / 2 + 1;
          if (a.dispY < b.dispY) {
            a.dispY -= pushY;
            b.dispY += pushY;
          } else {
            a.dispY += pushY;
            b.dispY -= pushY;
          }
          moved = true;
        }
      }
    }
    if (!moved) break;
  }
  return labels;
}

export default function PassiveTree({ specs, classId }) {
  const canvasRef = useRef(null);
  const containerRef = useRef(null);
  const hitAreasRef = useRef([]);
  const [treeData, setTreeData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [selectedSpec, setSelectedSpec] = useState(() => {
    try { return parseInt(localStorage.getItem('pob-trade-tree') || '0') || 0; } catch { return 0; }
  });
  const [ascendancyLabs, setAscendancyLabs] = useState(null);
  const [tooltip, setTooltip] = useState(null);
  const tooltipTimer = useRef(null);
  const [showDiffs, setShowDiffs] = useState(true);
  const [showLabels, setShowLabels] = useState(true);

  // Zoom & pan state
  const viewRef = useRef({ zoom: 1, panX: 0, panY: 0 });
  const dragRef = useRef({ dragging: false, lastX: 0, lastY: 0 });
  const [, forceRender] = useState(0);

  useEffect(() => {
    fetchTreeData()
      .then(d => { setTreeData(d); setLoading(false); })
      .catch(e => { setError(e.message); setLoading(false); });
  }, []);

  useEffect(() => {
    if (specs && specs.length > 1) {
      const saved = parseInt(localStorage.getItem('pob-trade-tree') || '0') || 0;
      const idx = saved < specs.length ? saved : specs.length - 1;
      setSelectedSpec(idx);
    }
  }, [specs]);

  // Compute ascendancy for selected spec
  const [ascViewClass, setAscViewClass] = useState(null);
  useEffect(() => {
    if (!treeData || !specs || specs.length === 0) { setAscendancyLabs(null); return; }
    const { nodes: treeNodes } = treeData;
    const idx = Math.min(selectedSpec, specs.length - 1);

    const specNotables = specs.slice(0, idx + 1).map(spec => {
      const notables = [];
      for (const id of spec.nodes) {
        const node = treeNodes[id];
        if (node?.ascendancyName && node.isNotable) {
          notables.push({ id, name: node.name || id, stats: node.sd?.length ? node.sd : (node.stats || []), ascendancy: node.ascendancyName });
        }
      }
      return notables;
    });

    const currentNotables = specNotables[specNotables.length - 1] || [];
    if (currentNotables.length === 0) { setAscendancyLabs(null); return; }

    const byClass = {};
    for (const n of currentNotables) {
      if (!byClass[n.ascendancy]) byClass[n.ascendancy] = [];
      byClass[n.ascendancy].push(n);
    }

    const classes = Object.keys(byClass);
    const classAscendancies = ASCENDANCY_BY_CLASS[classId] || [];
    let mainClass = classes.find(cls => classAscendancies.includes(cls)) || null;
    if (!mainClass) {
      classes.sort((a, b) => byClass[b].length - byClass[a].length);
      mainClass = classes[0];
    }

    const LAB_NAMES = ['Normal', 'Cruel', 'Merciless', 'Uber'];
    const classData = {};
    for (const cls of classes) {
      const clsNotables = byClass[cls];
      const notableOrder = [];
      const seen = new Set();
      for (let si = 0; si < specNotables.length; si++) {
        for (const n of specNotables[si]) {
          if (n.ascendancy === cls && !seen.has(n.id) && clsNotables.some(fn => fn.id === n.id)) {
            notableOrder.push(n);
            seen.add(n.id);
          }
        }
      }
      const labs = [];
      if (cls === mainClass) {
        for (let i = 0; i < Math.min(notableOrder.length, 4); i++) {
          labs.push({ label: LAB_NAMES[i], nodes: [notableOrder[i]] });
        }
      }
      classData[cls] = { labs, notables: notableOrder, isMain: cls === mainClass };
    }

    const classOrder = [mainClass, ...classes.filter(c => c !== mainClass)];
    setAscendancyLabs({ classes: classData, classOrder, mainClass });
    setAscViewClass(prev => (prev && classData[prev]) ? prev : mainClass);
  }, [treeData, specs, selectedSpec, classId]);

  const masteryEffects = useMemo(() => {
    if (!treeData || !specs || specs.length === 0) return [];
    const spec = specs[Math.min(selectedSpec, specs.length - 1)];
    const selections = spec.masterySelections || {};
    const results = [];
    for (const [nodeId, effectId] of Object.entries(selections)) {
      const node = treeData.nodes[nodeId];
      if (!node || !node.isMastery) continue;
      const effect = (node.masteryEffects || []).find(e => e.effect === effectId);
      if (effect) {
        let clusterNotable = null;
        if (node.group != null) {
          for (const [, n] of Object.entries(treeData.nodes)) {
            if (n.group === node.group && n.isNotable) {
              clusterNotable = n.name;
              break;
            }
          }
        }
        results.push({ name: node.name || `Mastery ${nodeId}`, stats: effect.stats || [], notable: clusterNotable });
      }
    }
    results.sort((a, b) => a.name.localeCompare(b.name));
    return results;
  }, [treeData, specs, selectedSpec]);

  // Compute jewel socket list for current spec, with cluster hierarchy
  const jewelList = useMemo(() => {
    if (!treeData || !specs || specs.length === 0) return [];
    const spec = specs[Math.min(selectedSpec, specs.length - 1)];
    const sockets = spec.jewelSockets || {};
    const positions = cachedPositions || {};

    // Separate into tree-native sockets (have position in GGG data) and cluster sub-sockets (generated, no position)
    const treeJewels = [];
    const clusterSubJewels = [];

    for (const [nodeId, item] of Object.entries(sockets)) {
      const entry = {
        nodeId,
        name: item.name,
        baseType: item.baseType,
        rarity: item.rarity,
        stats: (item.stats || []).map(s => s.line || s),
        isCluster: item.baseType.toLowerCase().includes('cluster'),
        isLargeCluster: item.baseType.toLowerCase().includes('large cluster'),
        isMediumCluster: item.baseType.toLowerCase().includes('medium cluster'),
        isSmallCluster: item.baseType.toLowerCase().includes('small cluster'),
        hasPosition: !!positions[nodeId],
      };
      if (entry.hasPosition) {
        treeJewels.push(entry);
      } else {
        clusterSubJewels.push(entry);
      }
    }

    // For tree jewels that are Large Clusters, attach sub-jewels
    // Sub-jewels don't have GGG tree positions — they're generated by cluster jewels
    for (const tj of treeJewels) {
      tj.subJewels = [];
      if (tj.isLargeCluster) {
        // Large clusters can have medium/small sub-jewels
        // We can't map them precisely to parents, so distribute evenly
        tj.subJewels = []; // filled below
      }
    }

    // Distribute cluster sub-jewels to large cluster parents
    const largeClusters = treeJewels.filter(j => j.isLargeCluster);
    const mediumClusters = clusterSubJewels.filter(j => j.isMediumCluster);
    const smallClusters = clusterSubJewels.filter(j => j.isSmallCluster);
    const otherSubJewels = clusterSubJewels.filter(j => !j.isMediumCluster && !j.isSmallCluster);

    // Attach mediums to large clusters (PoB doesn't tell us which goes where, so distribute)
    let medIdx = 0;
    for (const lc of largeClusters) {
      // Large clusters have 2 medium jewel sockets
      for (let i = 0; i < 2 && medIdx < mediumClusters.length; i++) {
        const med = mediumClusters[medIdx++];
        med.subJewels = [];
        lc.subJewels.push(med);
      }
    }

    // Attach smalls to medium clusters
    let smallIdx = 0;
    for (const lc of largeClusters) {
      for (const med of lc.subJewels) {
        // Medium clusters have 1 small jewel socket
        if (smallIdx < smallClusters.length) {
          med.subJewels.push(smallClusters[smallIdx++]);
        }
      }
    }

    // Attach ghastly/other sub-jewels to whoever has room
    for (const oj of otherSubJewels) {
      // These are likely abyss jewels in cluster sockets or similar
      if (largeClusters.length > 0) {
        largeClusters[0].subJewels.push(oj);
      } else {
        treeJewels.push(oj);
      }
    }

    // Also add any remaining unattached mediums/smalls
    for (; medIdx < mediumClusters.length; medIdx++) treeJewels.push(mediumClusters[medIdx]);
    for (; smallIdx < smallClusters.length; smallIdx++) treeJewels.push(smallClusters[smallIdx]);

    return treeJewels;
  }, [treeData, specs, selectedSpec]);

  const showTooltip = useCallback((x, y, node, extra) => {
    if (tooltipTimer.current) clearTimeout(tooltipTimer.current);
    const stats = (node.sd || node.reminderText || []).slice(0, 12);
    setTooltip({
      x, y,
      name: node.name || '',
      stats,
      isKeystone: node.isKeystone,
      isNotable: node.isNotable,
      isJewel: node.isJewel,
      isUnallocated: extra?.isUnallocated,
      jewelInfo: extra?.jewelInfo, // { name, baseType, stats[] } for equipped jewel
      nodeType: node.isKeystone ? 'Keystone' : node.isNotable ? 'Notable' : node.isMastery ? 'Mastery' : node.isJewelSocket ? 'Jewel Socket' : 'Passive',
    });
    tooltipTimer.current = setTimeout(() => setTooltip(null), 8000);
  }, []);

  // --- Canvas rendering ---
  const drawTree = useCallback(() => {
    if (!treeData || !specs || specs.length === 0) return;
    const canvas = canvasRef.current;
    if (!canvas) return;

    const ctx = canvas.getContext('2d');
    const dpr = window.devicePixelRatio || 1;
    const width = canvas.clientWidth;
    const height = canvas.clientHeight;
    canvas.width = width * dpr;
    canvas.height = height * dpr;
    ctx.scale(dpr, dpr);

    const { nodes: treeNodes, groups, constants } = treeData;
    const positions = computeAllPositions(treeData);

    const currentNodes = specs[selectedSpec]?.nodes || new Set();
    const prevNodes = selectedSpec > 0 ? (specs[selectedSpec - 1]?.nodes || new Set()) : null;
    const allAllocated = new Set([...currentNodes, ...(prevNodes || [])]);
    const jewelSockets = specs[selectedSpec]?.jewelSockets || {};

    if (currentNodes.size === 0) {
      ctx.fillStyle = '#0a0b0e';
      ctx.fillRect(0, 0, width, height);
      ctx.fillStyle = '#555';
      ctx.font = '13px sans-serif';
      ctx.textAlign = 'center';
      ctx.fillText('No tree nodes found', width / 2, height / 2);
      return;
    }

    // Bounding box of allocated nodes (skip ascendancy)
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const nodeId of allAllocated) {
      const node = treeNodes[nodeId];
      if (!node || node.ascendancyName) continue;
      const p = positions[nodeId];
      if (!p) continue;
      minX = Math.min(minX, p.x);
      minY = Math.min(minY, p.y);
      maxX = Math.max(maxX, p.x);
      maxY = Math.max(maxY, p.y);
    }

    const pad = Math.max((maxX - minX) * 0.12, (maxY - minY) * 0.12, 200);
    minX -= pad; minY -= pad; maxX += pad; maxY += pad;

    const treeW = maxX - minX;
    const treeH = maxY - minY;
    const baseScale = Math.min(width / treeW, height / treeH);

    // Apply zoom & pan
    const v = viewRef.current;
    const scale = baseScale * v.zoom;
    const centerX = (minX + maxX) / 2;
    const centerY = (minY + maxY) / 2;
    const offsetX = width / 2 - centerX * scale + v.panX;
    const offsetY = height / 2 - centerY * scale + v.panY;

    const tx = x => x * scale + offsetX;
    const ty = y => y * scale + offsetY;

    // Clear
    ctx.fillStyle = '#06070a';
    ctx.fillRect(0, 0, width, height);

    // --- Orbit rings ---
    const { orbitRadii } = constants;
    ctx.strokeStyle = 'rgba(40, 50, 70, 0.2)';
    ctx.lineWidth = 0.5;
    for (const [, group] of Object.entries(groups)) {
      const gx = tx(group.x);
      const gy = ty(group.y);
      if (gx < -300 || gx > width + 300 || gy < -300 || gy > height + 300) continue;
      for (const orbit of (group.orbits || [])) {
        if (orbit === 0) continue;
        const r = (orbitRadii[orbit] || 0) * scale;
        if (r < 1) continue;
        ctx.beginPath();
        ctx.arc(gx, gy, r, 0, Math.PI * 2);
        ctx.stroke();
      }
    }

    // --- All connections (skeleton) ---
    ctx.lineWidth = Math.max(0.3, scale * 4);
    ctx.strokeStyle = 'rgba(35, 45, 60, 0.3)';
    for (const [nodeId, node] of Object.entries(treeNodes)) {
      if (node.ascendancyName) continue;
      const from = positions[nodeId];
      if (!from) continue;
      const fx = tx(from.x);
      const fy = ty(from.y);
      if (fx < -200 || fx > width + 200 || fy < -200 || fy > height + 200) continue;

      for (const outId of (node.out || [])) {
        const outNode = treeNodes[outId];
        if (outNode?.ascendancyName) continue;
        const to = positions[outId];
        if (!to) continue;
        ctx.beginPath();
        ctx.moveTo(fx, fy);
        ctx.lineTo(tx(to.x), ty(to.y));
        ctx.stroke();
      }
    }

    // --- Hit areas (collect from all node types) ---
    const hitAreas = [];

    // --- Unallocated nodes (same size as allocated, dimmer color) ---
    for (const [nodeId, pos] of Object.entries(positions)) {
      if (allAllocated.has(nodeId)) continue;
      const node = treeNodes[nodeId];
      if (!node || node.classStartIndex !== undefined || node.ascendancyName || node.isBloodline) continue;

      const px = tx(pos.x);
      const py = ty(pos.y);
      if (px < -50 || px > width + 50 || py < -50 || py > height + 50) continue;

      // Same sizing as allocated nodes
      const baseR = node.isKeystone ? 6 : node.isNotable ? 4.5 : 2;
      const r = baseR * Math.min(v.zoom, 2.5);

      ctx.beginPath();
      ctx.arc(px, py, r, 0, Math.PI * 2);
      ctx.fillStyle = node.isKeystone ? 'rgba(90, 100, 130, 0.45)'
        : node.isNotable ? 'rgba(80, 95, 125, 0.4)'
        : 'rgba(70, 85, 115, 0.35)';
      ctx.fill();

      // Frame for notables/keystones (dimmer than allocated)
      if (node.isNotable || node.isKeystone) {
        ctx.strokeStyle = 'rgba(100, 115, 150, 0.35)';
        ctx.lineWidth = node.isKeystone ? 1.5 : 0.8;
        ctx.stroke();
      }

      // Hit area for tooltips on unallocated nodes too
      if (node.isKeystone || node.isNotable || node.name) {
        hitAreas.push({ id: nodeId, x: px, y: py, r: Math.max(r + 4, 10), node, isUnallocated: true });
      }
    }

    // --- Allocated connections ---
    ctx.lineWidth = Math.max(1.5, scale * 10);
    for (const nodeId of allAllocated) {
      const node = treeNodes[nodeId];
      if (!node || node.ascendancyName) continue;
      const from = positions[nodeId];
      if (!from) continue;

      for (const outId of (node.out || [])) {
        if (!allAllocated.has(outId)) continue;
        const outNode = treeNodes[outId];
        if (outNode?.ascendancyName) continue;
        const to = positions[outId];
        if (!to) continue;

        const fromNew = prevNodes && !prevNodes.has(nodeId) && currentNodes.has(nodeId);
        const toNew = prevNodes && !prevNodes.has(outId) && currentNodes.has(outId);
        const fromRemoved = prevNodes && prevNodes.has(nodeId) && !currentNodes.has(nodeId);
        const toRemoved = prevNodes && prevNodes.has(outId) && !currentNodes.has(outId);

        if (showDiffs && (fromNew || toNew)) {
          ctx.strokeStyle = 'rgba(50, 230, 110, 0.6)';
        } else if (showDiffs && (fromRemoved || toRemoved)) {
          ctx.strokeStyle = 'rgba(230, 60, 60, 0.5)';
        } else {
          ctx.strokeStyle = 'rgba(200, 176, 106, 0.6)';
        }

        ctx.beginPath();
        ctx.moveTo(tx(from.x), ty(from.y));
        ctx.lineTo(tx(to.x), ty(to.y));
        ctx.stroke();
      }
    }

    // --- Allocated nodes ---
    for (const nodeId of allAllocated) {
      const node = treeNodes[nodeId];
      if (!node || node.ascendancyName) continue;
      const pos = positions[nodeId];
      if (!pos) continue;

      const inCurrent = currentNodes.has(nodeId);
      const inPrev = prevNodes?.has(nodeId);
      const isNew = showDiffs && prevNodes && inCurrent && !inPrev;
      const isRemoved = showDiffs && prevNodes && !inCurrent && inPrev;

      // When diffs are off, skip removed nodes entirely
      if (!showDiffs && prevNodes && !inCurrent && inPrev) continue;

      const baseR = node.isKeystone ? 6 : node.isNotable ? 4.5 : (isRemoved ? 3 : 2);
      const r = baseR * Math.min(v.zoom, 2.5);
      const px = tx(pos.x);
      const py = ty(pos.y);

      if (px < -50 || px > width + 50 || py < -50 || py > height + 50) continue;

      // Glow (only when diffs visible)
      if (isNew || isRemoved) {
        ctx.beginPath();
        ctx.arc(px, py, r + (isRemoved ? 6 : 4), 0, Math.PI * 2);
        ctx.fillStyle = isNew ? 'rgba(50, 230, 110, 0.12)' : 'rgba(230, 60, 60, 0.15)';
        ctx.fill();
      }

      ctx.beginPath();
      ctx.arc(px, py, r, 0, Math.PI * 2);
      ctx.fillStyle = isRemoved ? '#dd4444' : isNew ? '#33ee77' : '#c8b06a';
      ctx.fill();

      if (node.isNotable || node.isKeystone) {
        ctx.strokeStyle = isNew ? '#33ee77' : isRemoved ? '#dd4444' : '#e8d48a';
        ctx.lineWidth = node.isKeystone ? 2 : 1.2;
        ctx.stroke();
      }

      // Hit area for all allocated nodes (every node should be inspectable)
      hitAreas.push({ id: nodeId, x: px, y: py, r: Math.max(r + 6, 14), node });
    }
    // --- Jewel sockets (diamond markers) ---
    for (const [nodeId, jewel] of Object.entries(jewelSockets)) {
      const pos = positions[nodeId];
      if (!pos) continue;
      const px = tx(pos.x);
      const py = ty(pos.y);
      if (px < -50 || px > width + 50 || py < -50 || py > height + 50) continue;

      const r = 8 * Math.min(v.zoom, 2.5);
      const isCluster = jewel.baseType.toLowerCase().includes('cluster');
      const isTimeless = jewel.name.toLowerCase().includes('glorious vanity') || jewel.name.toLowerCase().includes('brutal restraint') || jewel.name.toLowerCase().includes('militant faith') || jewel.name.toLowerCase().includes('elegant hubris') || jewel.name.toLowerCase().includes('lethal pride');
      const isThreadOfHope = jewel.name.toLowerCase().includes('thread of hope');
      const isUnique = jewel.rarity === 'Unique';

      // Outer glow
      ctx.beginPath();
      ctx.arc(px, py, r + 4, 0, Math.PI * 2);
      ctx.fillStyle = isCluster ? 'rgba(160, 120, 255, 0.15)' : isUnique ? 'rgba(175, 96, 37, 0.2)' : 'rgba(100, 200, 255, 0.15)';
      ctx.fill();

      // Diamond shape
      ctx.save();
      ctx.translate(px, py);
      ctx.rotate(Math.PI / 4);
      ctx.beginPath();
      ctx.rect(-r * 0.6, -r * 0.6, r * 1.2, r * 1.2);
      ctx.fillStyle = isCluster ? '#6a3fbf' : isTimeless ? '#d4af37' : isThreadOfHope ? '#e04040' : isUnique ? '#af6025' : '#3a7fc2';
      ctx.fill();
      ctx.strokeStyle = isCluster ? '#9b6fff' : isUnique ? '#e8a550' : '#5ab0ff';
      ctx.lineWidth = 1.5;
      ctx.stroke();
      ctx.restore();

      // Jewel name inside (if zoomed enough)
      if (v.zoom >= 1.5) {
        ctx.fillStyle = '#fff';
        ctx.font = `bold ${Math.min(9, 6 * v.zoom)}px system-ui, sans-serif`;
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        const shortName = jewel.name.length > 14 ? jewel.name.substring(0, 12) + '..' : jewel.name;
        ctx.fillText(shortName, px, py);
      }

      // Hit area for tooltip — show full jewel info
      const jewelStatLines = (jewel.stats || []).map(s => typeof s === 'string' ? s : (s.line || s));
      hitAreas.push({
        id: `jewel-${nodeId}`, x: px, y: py, r: Math.max(r + 8, 18),
        node: {
          name: jewel.name,
          isKeystone: false, isNotable: false, isJewel: true, isJewelSocket: true,
          sd: jewelStatLines,
        },
        jewelInfo: {
          name: jewel.name,
          baseType: jewel.baseType,
          rarity: jewel.rarity,
          stats: jewelStatLines,
        },
      });
    }
    hitAreasRef.current = hitAreas;

    // --- Labels with collision avoidance ---
    // Only label at sufficient zoom; show more labels as you zoom in
    const labelsVisible = showLabels && v.zoom >= 0.6;
    if (labelsVisible) {
      const labelSize = Math.max(8, Math.min(13, scale * 100 * v.zoom));
      ctx.font = `bold ${labelSize}px system-ui, -apple-system, sans-serif`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'bottom';

      const rawLabels = [];
      for (const nodeId of allAllocated) {
        const node = treeNodes[nodeId];
        if (!node || node.ascendancyName) continue;
        const pos = positions[nodeId];
        if (!pos) continue;

        const inCurrent = currentNodes.has(nodeId);
        const inPrev = prevNodes?.has(nodeId);
        const isNew = showDiffs && prevNodes && inCurrent && !inPrev;
        const isRemoved = showDiffs && prevNodes && !inCurrent && inPrev;

        // At low zoom: only keystones. Medium: + notables. High: + changed nodes
        const isKeystone = node.isKeystone;
        const isNotable = node.isNotable;
        if (v.zoom < 1.2 && !isKeystone && !isNotable) continue;
        if (v.zoom < 0.9 && !isKeystone) continue;
        if (!isKeystone && !isNotable && !isRemoved && !isNew) continue;
        // When diffs off, skip removed nodes from labels
        if (!showDiffs && prevNodes && !inCurrent && inPrev) continue;

        const px = tx(pos.x);
        const py = ty(pos.y);
        if (px < -50 || px > width + 50 || py < -50 || py > height + 50) continue;

        const label = node.name || nodeId;
        const w = ctx.measureText(label).width;
        const r = node.isKeystone ? 6 : node.isNotable ? 4.5 : 3;
        const priority = isKeystone ? 0 : isNotable ? 1 : 2;
        const color = isRemoved ? '#ff6666' : isNew ? '#44ff88' : '#e8d48a';

        rawLabels.push({ x: px, y: py, r, w, h: labelSize, label, color, priority });
      }

      // Sort by priority so keystones get best positions
      rawLabels.sort((a, b) => a.priority - b.priority);

      const resolved = resolveLabels(rawLabels);

      ctx.shadowColor = '#000';
      ctx.shadowBlur = 4;
      for (const lbl of resolved) {
        ctx.fillStyle = lbl.color;
        ctx.fillText(lbl.label, lbl.dispX, lbl.dispY);
      }
      ctx.shadowBlur = 0;
    }

    // --- Summary stats ---
    ctx.shadowColor = '#000';
    ctx.shadowBlur = 4;
    ctx.font = 'bold 12px system-ui, sans-serif';
    ctx.textAlign = 'left';
    ctx.textBaseline = 'top';

    if (showDiffs && prevNodes) {
      const added = [...currentNodes].filter(n => !prevNodes.has(n)).length;
      const removed = [...prevNodes].filter(n => !currentNodes.has(n)).length;
      ctx.fillStyle = '#33ee77';
      ctx.fillText(`+${added} nodes`, 12, 12);
      if (removed > 0) {
        ctx.fillStyle = '#ff5555';
        ctx.fillText(`-${removed} nodes`, 12, 30);
      }
      ctx.fillStyle = '#c8b06a';
      ctx.fillText(`${currentNodes.size} total`, 12, removed > 0 ? 48 : 30);
    } else {
      ctx.fillStyle = '#c8b06a';
      ctx.fillText(`${currentNodes.size} nodes`, 12, 12);
    }

    // Zoom indicator
    ctx.fillStyle = 'rgba(255,255,255,0.3)';
    ctx.font = '10px system-ui, sans-serif';
    ctx.textAlign = 'right';
    ctx.fillText(`${Math.round(v.zoom * 100)}%  · scroll to zoom · drag to pan`, width - 12, 12);
    ctx.shadowBlur = 0;

  }, [treeData, specs, selectedSpec, showDiffs, showLabels]);

  // Redraw on state changes
  useEffect(() => { drawTree(); }, [drawTree]);

  // Resize observer
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const obs = new ResizeObserver(() => drawTree());
    obs.observe(el);
    return () => obs.disconnect();
  }, [drawTree]);

  // --- Mouse/touch handlers for zoom & pan ---
  const handleWheel = useCallback((e) => {
    e.preventDefault();
    const v = viewRef.current;
    const delta = e.deltaY > 0 ? 0.85 : 1.18;
    const newZoom = Math.max(0.3, Math.min(8, v.zoom * delta));

    // Zoom toward mouse position
    const canvas = canvasRef.current;
    if (canvas) {
      const rect = canvas.getBoundingClientRect();
      const mx = e.clientX - rect.left;
      const my = e.clientY - rect.top;
      const cx = canvas.clientWidth / 2;
      const cy = canvas.clientHeight / 2;
      // Mouse offset from center (accounting for current pan)
      const dx = mx - cx - v.panX;
      const dy = my - cy - v.panY;
      const factor = newZoom / v.zoom;
      // Adjust pan so the point under the mouse stays fixed
      v.panX -= dx * (factor - 1);
      v.panY -= dy * (factor - 1);
    }

    v.zoom = newZoom;
    drawTree();
  }, [drawTree]);

  const handleMouseDown = useCallback((e) => {
    if (e.button !== 0) return;
    dragRef.current = { down: true, startX: e.clientX, startY: e.clientY, lastX: e.clientX, lastY: e.clientY, totalDist: 0 };
  }, []);

  const handleMouseMove = useCallback((e) => {
    const d = dragRef.current;
    if (d.down) {
      const dx = e.clientX - d.lastX;
      const dy = e.clientY - d.lastY;
      d.totalDist += Math.abs(dx) + Math.abs(dy);
      // Only pan if moved more than 4px (prevents drag on click)
      if (d.totalDist > 4) {
        viewRef.current.panX += dx;
        viewRef.current.panY += dy;
        d.lastX = e.clientX;
        d.lastY = e.clientY;
        drawTree();
        return;
      }
      d.lastX = e.clientX;
      d.lastY = e.clientY;
      return;
    }

    // Hover detection
    const canvas = canvasRef.current;
    if (!canvas) return;
    const rect = canvas.getBoundingClientRect();
    const mx = e.clientX - rect.left;
    const my = e.clientY - rect.top;
    let hovering = false;
    for (const hit of hitAreasRef.current) {
      const dx = mx - hit.x;
      const dy = my - hit.y;
      if (Math.sqrt(dx * dx + dy * dy) < hit.r) {
        hovering = true;
        break;
      }
    }
    canvas.style.cursor = (d.down && d.totalDist > 4) ? 'grabbing' : hovering ? 'pointer' : 'grab';
  }, [drawTree]);

  const handleMouseUp = useCallback(() => {
    dragRef.current.down = false;
  }, []);

  const handleCanvasClick = useCallback((e) => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const rect = canvas.getBoundingClientRect();
    const mx = e.clientX - rect.left;
    const my = e.clientY - rect.top;

    let closest = null;
    let closestDist = Infinity;
    for (const hit of hitAreasRef.current) {
      const dx = mx - hit.x;
      const dy = my - hit.y;
      const dist = Math.sqrt(dx * dx + dy * dy);
      if (dist < hit.r && dist < closestDist) {
        closest = hit;
        closestDist = dist;
      }
    }
    if (closest) {
      showTooltip(closest.x, closest.y, closest.node, {
        isUnallocated: closest.isUnallocated,
        jewelInfo: closest.jewelInfo,
      });
    } else {
      setTooltip(null);
    }
  }, [showTooltip]);

  // Attach wheel listener with passive: false
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    canvas.addEventListener('wheel', handleWheel, { passive: false });
    return () => canvas.removeEventListener('wheel', handleWheel);
  }, [handleWheel]);

  // Reset view when spec changes
  useEffect(() => {
    viewRef.current = { zoom: 1, panX: 0, panY: 0 };
  }, [selectedSpec]);

  // Reset zoom button
  const resetView = useCallback(() => {
    viewRef.current = { zoom: 1, panX: 0, panY: 0 };
    drawTree();
  }, [drawTree]);

  if (!specs || specs.length === 0) return null;
  if (error) return (
    <div className="bg-[#12141c] border border-slate-800 rounded-2xl p-4 mb-6 text-center text-xs text-red-400">
      Tree data error: {error}
    </div>
  );

  return (
    <div className="bg-[#12141c] border border-slate-800 rounded-2xl overflow-hidden shadow-lg mb-6">
      <div className="px-5 py-3 flex items-center justify-between border-b border-slate-800/50">
        <div className="flex items-center gap-3">
          <span className="text-xs font-black text-white uppercase tracking-widest">Passive Tree</span>
          <button
            onClick={resetView}
            className="text-[9px] text-slate-500 hover:text-blue-400 transition-colors bg-[#0a0b0e] border border-slate-800 rounded px-2 py-0.5 cursor-pointer"
          >
            Reset View
          </button>
          <button
            onClick={() => setShowLabels(v => !v)}
            className={`text-[9px] transition-colors border rounded px-2 py-0.5 cursor-pointer ${showLabels ? 'text-blue-400 bg-blue-900/30 border-blue-800' : 'text-slate-600 bg-[#0a0b0e] border-slate-800'}`}
          >
            Labels
          </button>
          {selectedSpec > 0 && (
            <button
              onClick={() => setShowDiffs(v => !v)}
              className={`text-[9px] transition-colors border rounded px-2 py-0.5 cursor-pointer ${showDiffs ? 'text-green-400 bg-green-900/30 border-green-800' : 'text-slate-600 bg-[#0a0b0e] border-slate-800'}`}
            >
              Diffs
            </button>
          )}
        </div>
        {specs.length > 1 && (
          <div className="flex gap-2 items-center flex-wrap">
            <select
              value={selectedSpec}
              onChange={e => { const v = +e.target.value; setSelectedSpec(v); try { localStorage.setItem('pob-trade-tree', String(v)); } catch {} }}
              className="bg-[#0a0b0e] border border-slate-800 rounded-lg px-2 py-1 text-[10px] text-blue-400 outline-none"
            >
              {specs.map((s, i) => <option key={i} value={i}>{s.title}</option>)}
            </select>
            {selectedSpec > 0 && (
              <span className="text-[10px] text-slate-600">vs {specs[selectedSpec - 1]?.title}</span>
            )}
          </div>
        )}
      </div>
      {selectedSpec > 0 && (
        <div className="px-5 py-2 flex gap-4 text-[9px] border-b border-slate-800/30 bg-[#0d0e12]">
          <span className="flex items-center gap-1.5">
            <span className="w-2.5 h-2.5 rounded-full bg-[#33ee77] inline-block" /> New
          </span>
          <span className="flex items-center gap-1.5">
            <span className="w-2.5 h-2.5 rounded-full bg-[#dd4444] inline-block" /> Removed
          </span>
          <span className="flex items-center gap-1.5">
            <span className="w-2.5 h-2.5 rounded-full bg-[#c8b06a] inline-block" /> Unchanged
          </span>
        </div>
      )}
      <div ref={containerRef} className="relative" style={{ height: 600 }}>
        {loading ? (
          <div className="flex items-center justify-center h-full text-slate-500 text-xs">
            Loading tree data...
          </div>
        ) : (
          <canvas
            ref={canvasRef}
            className="w-full h-full"
            onMouseDown={handleMouseDown}
            onMouseMove={handleMouseMove}
            onMouseUp={handleMouseUp}
            onMouseLeave={handleMouseUp}
            onClick={handleCanvasClick}
            style={{ cursor: 'grab' }}
          />
        )}
        {tooltip && (
          <div
            className="absolute z-10 pointer-events-none animate-fade-in"
            style={{
              left: Math.min(Math.max(tooltip.x, 140), (canvasRef.current?.clientWidth || 400) - 140),
              top: Math.max(tooltip.y - 14, 8),
              transform: 'translate(-50%, -100%)',
            }}
          >
            <div className="bg-[#1a1c28]/95 border border-slate-600 rounded-lg px-3 py-2.5 shadow-2xl max-w-[300px] backdrop-blur-sm">
              {/* Node type badge */}
              <div className="flex items-center gap-2 mb-1">
                {tooltip.nodeType && (
                  <span className={`text-[8px] font-bold uppercase px-1.5 py-0.5 rounded ${
                    tooltip.isKeystone ? 'bg-amber-900/40 text-amber-300' :
                    tooltip.isNotable ? 'bg-yellow-900/30 text-yellow-300' :
                    tooltip.isJewel ? 'bg-orange-900/30 text-orange-300' :
                    tooltip.isUnallocated ? 'bg-slate-800 text-slate-400' :
                    'bg-slate-800 text-slate-500'
                  }`}>
                    {tooltip.nodeType}
                  </span>
                )}
                {tooltip.isUnallocated && (
                  <span className="text-[8px] text-slate-600">Not allocated</span>
                )}
              </div>
              {/* Node name */}
              <div className={`text-xs font-black mb-1 ${
                tooltip.isJewel ? 'text-orange-400' :
                tooltip.isKeystone ? 'text-amber-300' :
                tooltip.isNotable ? 'text-[#e8d48a]' :
                tooltip.isUnallocated ? 'text-slate-400' :
                'text-slate-200'
              }`}>
                {tooltip.name || 'Passive Node'}
              </div>
              {/* Jewel info (for jewel sockets) */}
              {tooltip.jewelInfo && (
                <div className="mb-1.5 pb-1.5 border-b border-slate-700/50">
                  <div className={`text-[10px] font-semibold ${
                    tooltip.jewelInfo.rarity === 'Unique' ? 'text-orange-400' : 'text-blue-300'
                  }`}>
                    {tooltip.jewelInfo.name}
                  </div>
                  <div className="text-[9px] text-slate-500">{tooltip.jewelInfo.baseType}</div>
                  {tooltip.jewelInfo.stats?.length > 0 && (
                    <div className="mt-1 space-y-0.5">
                      {tooltip.jewelInfo.stats.map((s, i) => (
                        <div key={i} className="text-[9px] text-blue-300/70 leading-tight">{s}</div>
                      ))}
                    </div>
                  )}
                </div>
              )}
              {/* Node stats */}
              {tooltip.stats.length > 0 && (
                <div className="space-y-0.5">
                  {tooltip.stats.map((s, i) => (
                    <div key={i} className="text-[10px] text-blue-300/80 leading-tight">{s}</div>
                  ))}
                </div>
              )}
              {/* Fallback for nodes with no stats */}
              {tooltip.stats.length === 0 && !tooltip.jewelInfo && !tooltip.name && (
                <div className="text-[9px] text-slate-500 italic">No description available</div>
              )}
            </div>
          </div>
        )}
      </div>
      {jewelList.length > 0 && (
        <div className="px-5 py-3 border-t border-slate-800/50 bg-[#0d0e12]">
          <span className="text-[9px] font-black text-slate-500 uppercase tracking-widest block mb-2">
            Tree Jewels ({jewelList.length})
          </span>
          <div className="space-y-2">
            {jewelList.map((j, ji) => {
              const isUnique = j.rarity === 'Unique';
              const isCluster = j.isCluster;
              const hasChildren = j.subJewels && j.subJewels.length > 0;

              const JewelCard = ({ jewel, indent = 0 }) => {
                const iu = jewel.rarity === 'Unique';
                const ic = jewel.isCluster;
                const sizeLabel = jewel.isLargeCluster ? 'Large' : jewel.isMediumCluster ? 'Medium' : jewel.isSmallCluster ? 'Small' : '';
                return (
                  <div className={`bg-[#0a0b0e] border rounded-lg px-3 py-2 ${indent > 0 ? 'border-purple-900/40 ml-4' : indent > 1 ? 'border-purple-900/30 ml-8' : 'border-slate-800'}`}>
                    <div className="flex items-center gap-2 mb-1">
                      <span className={`w-2 h-2 rounded-sm rotate-45 inline-block shrink-0 ${ic ? 'bg-purple-500' : iu ? 'bg-orange-500' : 'bg-blue-500'}`} />
                      <span className={`text-[10px] font-bold ${iu ? 'text-orange-400' : ic ? 'text-purple-300' : 'text-blue-300'}`}>
                        {jewel.name}
                      </span>
                      {sizeLabel && <span className="text-[8px] text-purple-400/50 font-semibold uppercase">{sizeLabel}</span>}
                    </div>
                    <div className="text-[9px] text-slate-500 mb-1">{jewel.baseType}</div>
                    {jewel.stats.slice(0, 4).map((s, si) => (
                      <div key={si} className="text-[9px] text-blue-300/70 leading-tight">{s}</div>
                    ))}
                    {jewel.stats.length > 4 && (
                      <div className="text-[8px] text-slate-600">+{jewel.stats.length - 4} more</div>
                    )}
                    {jewel.subJewels && jewel.subJewels.length > 0 && (
                      <div className="mt-2 space-y-1.5 border-l-2 border-purple-800/30 pl-2">
                        {jewel.subJewels.map((sub, si) => (
                          <JewelCard key={si} jewel={sub} indent={indent + 1} />
                        ))}
                      </div>
                    )}
                  </div>
                );
              };

              return (
                <div key={ji} className={hasChildren ? '' : 'grid grid-cols-1'}>
                  <JewelCard jewel={j} indent={0} />
                </div>
              );
            })}
          </div>
        </div>
      )}
      {ascendancyLabs && ascendancyLabs.classOrder && ascendancyLabs.classOrder.length > 0 && (
        <div className="px-5 py-3 border-t border-slate-800/50 bg-[#0d0e12]">
          <div className="flex items-center gap-3 mb-2">
            <span className="text-[9px] font-black text-slate-500 uppercase tracking-widest">Ascendancy</span>
            {ascendancyLabs.classOrder.length > 1 ? (
              <div className="flex gap-1">
                {ascendancyLabs.classOrder.map(cls => {
                  const isMain = cls === ascendancyLabs.mainClass;
                  const isActive = cls === ascViewClass;
                  return (
                    <button
                      key={cls}
                      onClick={() => setAscViewClass(cls)}
                      className={`px-2 py-0.5 rounded text-[9px] font-bold transition-all cursor-pointer ${isActive ? 'bg-amber-900/40 text-amber-300 border border-amber-700' : 'bg-[#1a1c28] text-slate-500 border border-slate-800 hover:text-slate-300'}`}
                    >
                      {cls}{isMain ? '' : ' (Boss)'}
                    </button>
                  );
                })}
              </div>
            ) : (
              <span className="text-[9px] font-bold text-amber-300/70">{ascendancyLabs.classOrder[0]}</span>
            )}
          </div>
          {(() => {
            const cls = ascViewClass || ascendancyLabs.mainClass;
            const data = ascendancyLabs.classes[cls];
            if (!data) return null;
            if (data.labs.length > 0) {
              return (
                <div className="space-y-1.5">
                  {data.labs.map((lab, li) => (
                    <div key={li} className="flex items-start gap-2">
                      <span className="text-[8px] font-bold text-slate-600 uppercase w-16 shrink-0 pt-0.5">{lab.label}</span>
                      <div>
                        {lab.nodes.map((n, ni) => (
                          <div key={ni}>
                            <span className="text-[10px] text-amber-300/90 font-semibold">{n.name}</span>
                            {n.stats.length > 0 && (
                              <div className="ml-1 mt-0.5">
                                {n.stats.map((s, si) => (
                                  <div key={si} className="text-[9px] text-blue-300/80 leading-tight">{s}</div>
                                ))}
                              </div>
                            )}
                          </div>
                        ))}
                      </div>
                    </div>
                  ))}
                </div>
              );
            }
            return (
              <div className="space-y-1.5">
                {data.notables.map((n, ni) => (
                  <div key={ni}>
                    <span className="text-[10px] text-amber-300/90 font-semibold">{n.name}</span>
                    {n.stats.length > 0 && (
                      <div className="ml-1 mt-0.5">
                        {n.stats.map((s, si) => (
                          <div key={si} className="text-[9px] text-blue-300/80 leading-tight">{s}</div>
                        ))}
                      </div>
                    )}
                  </div>
                ))}
              </div>
            );
          })()}
        </div>
      )}
      {masteryEffects.length > 0 && (
        <div className="px-5 py-3 border-t border-slate-800/50 bg-[#0d0e12]">
          <span className="text-[9px] font-black text-slate-500 uppercase tracking-widest block mb-2">Masteries</span>
          <div className="space-y-1.5">
            {masteryEffects.map((m, mi) => (
              <div key={mi}>
                <span className="text-[10px] text-purple-300/90 font-semibold">{m.name}</span>
                {m.notable && <span className="text-[9px] text-slate-500 ml-1.5">({m.notable})</span>}
                {m.stats.map((s, si) => (
                  <div key={si} className="text-[9px] text-blue-300/80 leading-tight ml-1">{s}</div>
                ))}
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
