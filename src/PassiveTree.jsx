import { useEffect, useRef, useState, useCallback } from 'react';

const TREE_DATA_URL = 'https://raw.githubusercontent.com/grindinggear/skilltree-export/master/data.json';

let cachedTreeData = null;
let cachedPositions = null; // { nodeId: {x, y} }

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

export default function PassiveTree({ specs }) {
  const canvasRef = useRef(null);
  const hitAreasRef = useRef([]); // [{id, x, y, r, node}]
  const [treeData, setTreeData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [selectedSpec, setSelectedSpec] = useState(() => {
    try { return parseInt(localStorage.getItem('pob-trade-tree') || '0') || 0; } catch { return 0; }
  });
  const [ascendancyNodes, setAscendancyNodes] = useState([]);
  const [tooltip, setTooltip] = useState(null); // {x, y, node, stats}
  const tooltipTimer = useRef(null);

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

  const showTooltip = useCallback((x, y, node) => {
    if (tooltipTimer.current) clearTimeout(tooltipTimer.current);
    const stats = (node.sd || node.reminderText || []).slice(0, 6);
    setTooltip({ x, y, name: node.name || '', stats, isKeystone: node.isKeystone, isNotable: node.isNotable });
    tooltipTimer.current = setTimeout(() => setTooltip(null), 2000);
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
      if (dist < hit.r + 8 && dist < closestDist) {
        closest = hit;
        closestDist = dist;
      }
    }
    if (closest) {
      showTooltip(closest.x, closest.y, closest.node);
    } else {
      setTooltip(null);
    }
  }, [showTooltip]);

  const handleCanvasMove = useCallback((e) => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const rect = canvas.getBoundingClientRect();
    const mx = e.clientX - rect.left;
    const my = e.clientY - rect.top;

    let hovering = false;
    for (const hit of hitAreasRef.current) {
      const dx = mx - hit.x;
      const dy = my - hit.y;
      if (Math.sqrt(dx * dx + dy * dy) < hit.r + 8) {
        hovering = true;
        break;
      }
    }
    canvas.style.cursor = hovering ? 'pointer' : 'default';
  }, []);

  useEffect(() => {
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

    // Compute ordered ascendancy nodes via BFS from ascendancy start
    const allocAsc = [...currentNodes].filter(id => treeNodes[id]?.ascendancyName && !treeNodes[id]?.isAscendancyStart);
    if (allocAsc.length > 0) {
      const ascName = treeNodes[allocAsc[0]]?.ascendancyName;
      const startId = Object.keys(treeNodes).find(id => treeNodes[id]?.isAscendancyStart && treeNodes[id]?.ascendancyName === ascName);
      if (startId) {
        const ordered = [];
        const visited = new Set();
        const queue = [startId];
        visited.add(startId);
        while (queue.length > 0) {
          const cur = queue.shift();
          if (cur !== startId && allocAsc.includes(cur)) {
            ordered.push({ id: cur, name: treeNodes[cur]?.name || cur, stats: treeNodes[cur]?.sd || [] });
          }
          for (const outId of (treeNodes[cur]?.out || [])) {
            if (!visited.has(outId) && treeNodes[outId]?.ascendancyName === ascName) {
              visited.add(outId);
              queue.push(outId);
            }
          }
          for (const [nid, n] of Object.entries(treeNodes)) {
            if (!visited.has(nid) && n?.ascendancyName === ascName && (n.out || []).some(o => String(o) === String(cur))) {
              visited.add(nid);
              queue.push(nid);
            }
          }
        }
        for (const id of allocAsc) {
          if (!ordered.find(n => n.id === id)) {
            ordered.push({ id, name: treeNodes[id]?.name || id, stats: treeNodes[id]?.sd || [] });
          }
        }
        setAscendancyNodes(ordered);
      } else {
        setAscendancyNodes(allocAsc.map(id => ({ id, name: treeNodes[id]?.name || id, stats: treeNodes[id]?.sd || [] })));
      }
    } else {
      setAscendancyNodes([]);
    }

    if (currentNodes.size === 0) {
      ctx.fillStyle = '#0a0b0e';
      ctx.fillRect(0, 0, width, height);
      ctx.fillStyle = '#555';
      ctx.font = '11px sans-serif';
      ctx.textAlign = 'center';
      ctx.fillText('No tree nodes found', width / 2, height / 2);
      return;
    }

    // Bounding box of allocated nodes - skip ascendancy nodes
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const nodeId of allAllocated) {
      const node = treeNodes[nodeId];
      if (!node) continue;
      if (node.ascendancyName) continue;
      const p = positions[nodeId];
      if (!p) continue;
      minX = Math.min(minX, p.x);
      minY = Math.min(minY, p.y);
      maxX = Math.max(maxX, p.x);
      maxY = Math.max(maxY, p.y);
    }

    // Expand bounds to show some surrounding context
    const expandX = (maxX - minX) * 0.15;
    const expandY = (maxY - minY) * 0.15;
    const ctxPad = Math.max(expandX, expandY, 200);
    minX -= ctxPad; minY -= ctxPad; maxX += ctxPad; maxY += ctxPad;

    const treeW = maxX - minX;
    const treeH = maxY - minY;
    const scale = Math.min(width / treeW, height / treeH);
    const offsetX = (width - treeW * scale) / 2 - minX * scale;
    const offsetY = (height - treeH * scale) / 2 - minY * scale;

    const tx = x => x * scale + offsetX;
    const ty = y => y * scale + offsetY;

    // Clear with dark background
    ctx.fillStyle = '#06070a';
    ctx.fillRect(0, 0, width, height);

    // --- Draw group orbit rings (background structure) ---
    const { orbitRadii } = constants;
    ctx.strokeStyle = 'rgba(40, 50, 70, 0.25)';
    ctx.lineWidth = 0.5;
    for (const [, group] of Object.entries(groups)) {
      const gx = tx(group.x);
      const gy = ty(group.y);
      if (gx < -200 || gx > width + 200 || gy < -200 || gy > height + 200) continue;
      for (const orbit of (group.orbits || [])) {
        if (orbit === 0) continue;
        const r = (orbitRadii[orbit] || 0) * scale;
        if (r < 1) continue;
        ctx.beginPath();
        ctx.arc(gx, gy, r, 0, Math.PI * 2);
        ctx.stroke();
      }
    }

    // --- Draw ALL connections faintly (tree skeleton) ---
    ctx.lineWidth = Math.max(0.3, scale * 4);
    for (const [nodeId, node] of Object.entries(treeNodes)) {
      if (node.ascendancyName) continue;
      const from = positions[nodeId];
      if (!from) continue;
      const fx = tx(from.x);
      const fy = ty(from.y);
      if (fx < -100 || fx > width + 100 || fy < -100 || fy > height + 100) continue;

      for (const outId of (node.out || [])) {
        const outNode = treeNodes[outId];
        if (outNode?.ascendancyName) continue;
        const to = positions[outId];
        if (!to) continue;
        ctx.strokeStyle = 'rgba(35, 45, 60, 0.35)';
        ctx.beginPath();
        ctx.moveTo(fx, fy);
        ctx.lineTo(tx(to.x), ty(to.y));
        ctx.stroke();
      }
    }

    // --- Draw ALL unallocated nodes faintly ---
    for (const [nodeId, pos] of Object.entries(positions)) {
      if (allAllocated.has(nodeId)) continue;
      const node = treeNodes[nodeId];
      if (!node || node.classStartIndex !== undefined) continue;
      if (node.ascendancyName || node.isBloodline) continue;

      const px = tx(pos.x);
      const py = ty(pos.y);
      if (px < -50 || px > width + 50 || py < -50 || py > height + 50) continue;

      const r = node.isKeystone ? 2 : node.isNotable ? 1.5 : 0.8;
      ctx.beginPath();
      ctx.arc(px, py, r, 0, Math.PI * 2);
      ctx.fillStyle = 'rgba(50, 60, 80, 0.4)';
      ctx.fill();
    }

    // --- Draw allocated connections brightly ---
    ctx.lineWidth = Math.max(1, scale * 8);
    for (const nodeId of allAllocated) {
      const node = treeNodes[nodeId];
      if (!node) continue;
      if (node.ascendancyName) continue;
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

        if (fromNew || toNew) {
          ctx.strokeStyle = 'rgba(50, 230, 110, 0.5)';
        } else if (fromRemoved || toRemoved) {
          ctx.strokeStyle = 'rgba(230, 60, 60, 0.4)';
        } else {
          ctx.strokeStyle = 'rgba(180, 160, 110, 0.5)';
        }

        ctx.beginPath();
        ctx.moveTo(tx(from.x), ty(from.y));
        ctx.lineTo(tx(to.x), ty(to.y));
        ctx.stroke();
      }
    }

    // --- Draw allocated nodes + collect hit areas ---
    const hitAreas = [];
    for (const nodeId of allAllocated) {
      const node = treeNodes[nodeId];
      if (!node) continue;
      if (node.ascendancyName) continue;
      const pos = positions[nodeId];
      if (!pos) continue;

      const inCurrent = currentNodes.has(nodeId);
      const inPrev = prevNodes?.has(nodeId);
      const isNew = prevNodes && inCurrent && !inPrev;
      const isRemoved = prevNodes && !inCurrent && inPrev;
      const isClickable = node.isKeystone || node.isNotable || node.orbit === 0;

      const r = node.isKeystone ? 4 : node.isNotable ? 3 : 1.5;
      const px = tx(pos.x);
      const py = ty(pos.y);

      // Glow for new/removed
      if (isNew || isRemoved) {
        ctx.beginPath();
        ctx.arc(px, py, r + 3, 0, Math.PI * 2);
        ctx.fillStyle = isNew ? 'rgba(50, 230, 110, 0.15)' : 'rgba(230, 60, 60, 0.12)';
        ctx.fill();
      }

      ctx.beginPath();
      ctx.arc(px, py, r, 0, Math.PI * 2);

      if (isRemoved) {
        ctx.fillStyle = '#dd4444';
      } else if (isNew) {
        ctx.fillStyle = '#33ee77';
      } else {
        ctx.fillStyle = '#c8b06a';
      }
      ctx.fill();

      // Frame for notables/keystones
      if (node.isNotable || node.isKeystone) {
        ctx.strokeStyle = isNew ? '#33ee77' : isRemoved ? '#dd4444' : '#e8d48a';
        ctx.lineWidth = node.isKeystone ? 1.5 : 1;
        ctx.stroke();
      }

      // Collect hit areas for clickable nodes (no visual indicator — just larger tap target)
      if (isClickable) {
        hitAreas.push({ id: nodeId, x: px, y: py, r: Math.max(r + 6, 12), node });
      }
    }
    hitAreasRef.current = hitAreas;

    // --- Labels for keystones and changed notables ---
    const labelSize = Math.max(6, Math.min(10, scale * 80));
    ctx.font = `bold ${labelSize}px system-ui, sans-serif`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'bottom';

    for (const nodeId of allAllocated) {
      const node = treeNodes[nodeId];
      if (!node) continue;
      if (node.ascendancyName) continue;
      if (!node.isKeystone && !node.isNotable) continue;
      const pos = positions[nodeId];
      if (!pos) continue;

      const inCurrent = currentNodes.has(nodeId);
      const inPrev = prevNodes?.has(nodeId);
      const isNew = prevNodes && inCurrent && !inPrev;
      const isRemoved = prevNodes && !inCurrent && inPrev;

      if (!node.isKeystone && !isNew && !isRemoved) continue;

      const r = node.isKeystone ? 4 : 3;
      ctx.fillStyle = isNew ? '#33ee77' : isRemoved ? '#ff5555' : '#e8d48a';
      ctx.globalAlpha = isNew || isRemoved || node.isKeystone ? 1 : 0.7;

      ctx.shadowColor = '#000';
      ctx.shadowBlur = 3;
      const lx = tx(pos.x);
      const ly = ty(pos.y) - r - 3;
      const labelW = ctx.measureText(node.name || '').width;
      const clampedX = Math.max(labelW / 2 + 4, Math.min(width - labelW / 2 - 4, lx));
      ctx.fillText(node.name || '', clampedX, Math.max(12, ly));
      ctx.shadowBlur = 0;
      ctx.globalAlpha = 1;
    }

    // --- Summary stats ---
    ctx.shadowColor = '#000';
    ctx.shadowBlur = 4;
    ctx.font = 'bold 11px system-ui, sans-serif';
    ctx.textAlign = 'left';
    ctx.textBaseline = 'top';

    if (prevNodes) {
      const added = [...currentNodes].filter(n => !prevNodes.has(n)).length;
      const removed = [...prevNodes].filter(n => !currentNodes.has(n)).length;
      ctx.fillStyle = '#33ee77';
      ctx.fillText(`+${added} nodes`, 10, 10);
      if (removed > 0) {
        ctx.fillStyle = '#ff5555';
        ctx.fillText(`-${removed} nodes`, 10, 26);
      }
      ctx.fillStyle = '#c8b06a';
      ctx.fillText(`${currentNodes.size} total`, 10, removed > 0 ? 42 : 26);
    } else {
      ctx.fillStyle = '#c8b06a';
      ctx.fillText(`${currentNodes.size} nodes allocated`, 10, 10);
    }
    ctx.shadowBlur = 0;

  }, [treeData, specs, selectedSpec]);

  if (!specs || specs.length === 0) return null;
  if (error) return (
    <div className="bg-[#12141c] border border-slate-800 rounded-2xl p-4 mb-6 text-center text-xs text-red-400">
      Tree data error: {error}
    </div>
  );

  const LAB_NAMES = ['Normal', 'Cruel', 'Merciless', 'Uber'];

  return (
    <div className="bg-[#12141c] border border-slate-800 rounded-2xl overflow-hidden shadow-lg mb-6">
      <div className="px-5 py-3 flex items-center justify-between border-b border-slate-800/50">
        <span className="text-xs font-black text-white uppercase tracking-widest">Passive Tree</span>
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
      <div className="relative">
        {loading ? (
          <div className="flex items-center justify-center py-16 text-slate-500 text-xs">
            Loading tree data...
          </div>
        ) : (
          <canvas
            ref={canvasRef}
            className="w-full"
            style={{ height: 400 }}
            onClick={handleCanvasClick}
            onMouseMove={handleCanvasMove}
          />
        )}
        {tooltip && (
          <div
            className="absolute z-10 pointer-events-none animate-fade-in"
            style={{
              left: Math.min(tooltip.x, (canvasRef.current?.clientWidth || 300) - 180),
              top: Math.max(tooltip.y - 10, 4),
              transform: 'translate(-50%, -100%)',
            }}
          >
            <div className="bg-[#1a1c28] border border-slate-700 rounded-lg px-3 py-2 shadow-xl max-w-[220px]">
              <div className={`text-[11px] font-black mb-1 ${tooltip.isKeystone ? 'text-amber-300' : tooltip.isNotable ? 'text-[#e8d48a]' : 'text-slate-200'}`}>
                {tooltip.name}
              </div>
              {tooltip.stats.length > 0 && (
                <div className="space-y-0.5">
                  {tooltip.stats.map((s, i) => (
                    <div key={i} className="text-[9px] text-blue-300/80 leading-tight">{s}</div>
                  ))}
                </div>
              )}
            </div>
          </div>
        )}
      </div>
      {ascendancyNodes.length > 0 && (
        <div className="px-5 py-3 border-t border-slate-800/50 bg-[#0d0e12]">
          <div className="flex items-center gap-3 flex-wrap">
            <span className="text-[9px] font-black text-slate-500 uppercase tracking-widest shrink-0">Ascendancy</span>
            {[0, 1, 2, 3].map(lab => {
              const pair = ascendancyNodes.slice(lab * 2, lab * 2 + 2);
              if (pair.length === 0) return null;
              return (
                <div key={lab} className="group relative flex items-center gap-1.5">
                  <span className="text-[8px] font-bold text-slate-600 uppercase">{LAB_NAMES[lab]}:</span>
                  {pair.map((n, i) => (
                    <span key={i} className="relative">
                      <span className="text-[10px] text-amber-300/90 font-semibold cursor-default hover:text-amber-200 transition-colors border-b border-dashed border-amber-300/20 hover:border-amber-300/60">
                        {n.name}
                      </span>
                      {n.stats.length > 0 && (
                        <span className="absolute bottom-full left-1/2 -translate-x-1/2 mb-2 hidden group-hover:block hover:block z-20 pointer-events-none">
                          <span className="bg-[#1a1c28] border border-slate-700 rounded-lg px-3 py-2 shadow-xl block max-w-[240px] min-w-[160px]">
                            <span className="text-[10px] font-black text-amber-300 block mb-1">{n.name}</span>
                            {n.stats.map((s, si) => (
                              <span key={si} className="text-[9px] text-blue-300/80 leading-tight block">{s}</span>
                            ))}
                          </span>
                        </span>
                      )}
                    </span>
                  ))}
                  {lab < 3 && ascendancyNodes.length > (lab + 1) * 2 && (
                    <span className="text-slate-700 mx-0.5">|</span>
                  )}
                </div>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}
