import { useState, useEffect, useMemo, useCallback, useRef } from 'react';
import {
  JEWEL_TYPES,
  parseTimelessJewel,
  getLegionPassives,
  getJewelSockets,
  getTradeIds,
  searchSeeds,
  searchSeedsByDPS,
  findSimilarSeeds,
  getTransforms,
  getNodesInRadius,
  getAvailableMods,
  buildTradeUrl,
} from './timelessJewels';
import { fetchTreeData, computeAllPositions } from './PassiveTree';

export default function TimelessSearch({ specs, treeData, selectedLeague, pobCode }) {
  const [passives, setPassives] = useState(null);
  const [sockets, setSockets] = useState(null);
  const [tradeIds, setTradeIds] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);

  // Search state
  const [selectedSocket, setSelectedSocket] = useState('');
  const [selectedJewelType, setSelectedJewelType] = useState('');
  const [selectedConqueror, setSelectedConqueror] = useState(0);
  const [desiredMods, setDesiredMods] = useState([]);
  const [budgetMin, setBudgetMin] = useState(0);
  const [allocatedOnly, setAllocatedOnly] = useState(true);
  const [results, setResults] = useState(null);
  const [searchTime, setSearchTime] = useState(0);
  const [similarResults, setSimilarResults] = useState(null);
  const [activeTab, setActiveTab] = useState('search'); // 'search' | 'similar' | 'preview' | 'dps'
  const [previewSeed, setPreviewSeed] = useState(null);
  const [previewTransforms, setPreviewTransforms] = useState(null);
  const [autoFilled, setAutoFilled] = useState(false);

  // DPS/EHP search state
  const [searchMode, setSearchMode] = useState('mods'); // 'mods' | 'dps'
  const [dpsWeight, setDpsWeight] = useState(70);
  const [ehpWeight, setEhpWeight] = useState(30);
  const [preFilterTop, setPreFilterTop] = useState(50);
  const [dpsResults, setDpsResults] = useState(null);
  const [dpsElapsed, setDpsElapsed] = useState(0);
  const timerRef = useRef(null);
  // Multi-socket selection for DPS mode
  const [selectedDpsSockets, setSelectedDpsSockets] = useState(new Set());

  // Load static data
  useEffect(() => {
    Promise.all([getLegionPassives(), getJewelSockets(), getTradeIds()])
      .then(([p, s, t]) => { setPassives(p); setSockets(s); setTradeIds(t); })
      .catch(e => setError(e.message));
  }, []);

  // Detect timeless jewels in build
  const timelessJewels = useMemo(() => {
    if (!specs || specs.length === 0) return [];
    const found = [];
    const seen = new Set();
    for (const spec of specs) {
      for (const [nodeId, item] of Object.entries(spec.jewelSockets || {})) {
        if (seen.has(nodeId)) continue;
        const parsed = parseTimelessJewel(item);
        if (parsed) { found.push({ nodeId, item, parsed }); seen.add(nodeId); }
      }
    }
    return found;
  }, [specs]);

  // Allocated node set (last spec)
  const allocatedNodeSet = useMemo(() => {
    if (!specs || specs.length === 0) return null;
    const s = specs[specs.length - 1];
    if (!s?.nodes) return null;
    return s.nodes instanceof Set ? s.nodes : new Set(Array.isArray(s.nodes) ? s.nodes.map(String) : []);
  }, [specs]);

  // Auto-fill from detected jewel
  useEffect(() => {
    if (autoFilled || timelessJewels.length === 0) return;
    const tj = timelessJewels[0];
    setSelectedSocket(tj.nodeId);
    setSelectedJewelType(tj.parsed.jewelName);
    setSelectedConqueror(tj.parsed.conquerorIdx);
    setAutoFilled(true);
  }, [timelessJewels, autoFilled]);

  // Socket list (allocated only, labeled by keystone, with detected jewel info)
  const socketList = useMemo(() => {
    if (!sockets || !allocatedNodeSet) return [];
    return sockets
      .filter(s => allocatedNodeSet.has(String(s.node_id)))
      .map(s => {
        const tj = timelessJewels.find(j => String(j.nodeId) === String(s.node_id));
        return { ...s, socketedJewel: tj?.parsed || null };
      })
      .sort((a, b) => (b.socketedJewel ? 1 : 0) - (a.socketedJewel ? 1 : 0) || a.keystone.localeCompare(b.keystone));
  }, [sockets, allocatedNodeSet, timelessJewels]);

  // Nodes in radius (for single socket)
  const nodesInRadius = useMemo(() => {
    if (!selectedSocket || !treeData) return [];
    const positions = computeAllPositions(treeData);
    const { nodes } = treeData;
    let inRadius = getNodesInRadius(selectedSocket, positions, nodes);
    if (allocatedOnly && allocatedNodeSet) {
      inRadius = inRadius.filter(n => allocatedNodeSet.has(n.nodeId) || allocatedNodeSet.has(String(n.nodeId)));
    }
    return inRadius;
  }, [selectedSocket, treeData, allocatedOnly, allocatedNodeSet]);

  // Nodes in radius for any socket (for multi-socket DPS mode)
  const getNodesForSocket = useCallback((socketNodeId) => {
    if (!treeData) return [];
    const positions = computeAllPositions(treeData);
    const { nodes } = treeData;
    let inRadius = getNodesInRadius(socketNodeId, positions, nodes);
    if (allocatedOnly && allocatedNodeSet) {
      inRadius = inRadius.filter(n => allocatedNodeSet.has(n.nodeId) || allocatedNodeSet.has(String(n.nodeId)));
    }
    return inRadius;
  }, [treeData, allocatedOnly, allocatedNodeSet]);

  const currentJewelType = JEWEL_TYPES[selectedJewelType] || null;
  const availableMods = useMemo(() => passives ? getAvailableMods(passives) : [], [passives]);

  // Mod management
  const addMod = useCallback((modId) => {
    if (desiredMods.some(m => m.id === modId)) return;
    const mod = availableMods.find(m => m.id === modId);
    if (mod) setDesiredMods(prev => [...prev, { ...mod, weight: 1, required: false }]);
  }, [availableMods, desiredMods]);

  const removeMod = useCallback((modId) => setDesiredMods(prev => prev.filter(m => m.id !== modId)), []);
  const updateWeight = useCallback((modId, w) => setDesiredMods(prev => prev.map(m => m.id === modId ? { ...m, weight: Math.max(1, Math.min(10, w)) } : m)), []);
  const toggleRequired = useCallback((modId) => setDesiredMods(prev => prev.map(m => m.id === modId ? { ...m, required: !m.required } : m)), []);

  // Multi-socket toggle
  const toggleDpsSocket = useCallback((nodeId) => {
    setSelectedDpsSockets(prev => {
      const next = new Set(prev);
      if (next.has(nodeId)) next.delete(nodeId);
      else next.add(nodeId);
      return next;
    });
  }, []);

  // Search (by mods - existing)
  const runSearch = useCallback(async () => {
    if (!currentJewelType || nodesInRadius.length === 0 || desiredMods.length === 0) return;
    setLoading(true); setError(null);
    try {
      const nodeIds = nodesInRadius.map(n => parseInt(n.nodeId));
      const mods = desiredMods.map(m => ({ legionId: m.id, weight: m.weight }));
      const required = desiredMods.filter(m => m.required).map(m => m.id);
      const data = await searchSeeds(currentJewelType.type, nodeIds, mods, {
        minScore: budgetMin, maxResults: 100, requiredMods: required,
      });
      setResults(data);
      setSearchTime(data.timing);
      setActiveTab('search');
    } catch (e) { setError(e.message); }
    finally { setLoading(false); }
  }, [currentJewelType, nodesInRadius, desiredMods, budgetMin]);

  // Search by DPS/EHP
  const runDpsSearch = useCallback(async () => {
    if (!pobCode || !currentJewelType) return;

    // Build socket list for the request
    const socketsToSearch = searchMode === 'dps' && selectedDpsSockets.size > 0
      ? [...selectedDpsSockets]
      : selectedSocket ? [selectedSocket] : [];

    if (socketsToSearch.length === 0) return;

    setLoading(true); setError(null); setDpsElapsed(0);
    const startTime = Date.now();
    timerRef.current = setInterval(() => setDpsElapsed(Math.round((Date.now() - startTime) / 1000)), 500);

    try {
      const socketParams = socketsToSearch.map(socketNodeId => {
        const nodes = getNodesForSocket(socketNodeId);
        // Find jewel info for this socket
        const tj = timelessJewels.find(j => String(j.nodeId) === String(socketNodeId));
        return {
          socketNodeId: String(socketNodeId),
          jewelType: tj?.parsed?.type || currentJewelType.type,
          conquerorIdx: tj?.parsed?.conquerorIdx ?? selectedConqueror,
          nodeIds: nodes.map(n => parseInt(n.nodeId)),
        };
      });

      const data = await searchSeedsByDPS(pobCode, socketParams, {
        dpsWeight: dpsWeight / 100,
        ehpWeight: ehpWeight / 100,
        preFilterTop,
        maxResults: 20,
        desiredMods: desiredMods.length > 0 ? desiredMods.map(m => ({ legionId: m.id, weight: m.weight })) : undefined,
      });

      setDpsResults(data);
      setActiveTab('dps');
    } catch (e) { setError(e.message); }
    finally {
      setLoading(false);
      clearInterval(timerRef.current);
      timerRef.current = null;
    }
  }, [pobCode, currentJewelType, selectedSocket, selectedDpsSockets, searchMode, selectedConqueror, timelessJewels, getNodesForSocket, dpsWeight, ehpWeight, preFilterTop, desiredMods]);

  // Cleanup timer on unmount
  useEffect(() => () => { if (timerRef.current) clearInterval(timerRef.current); }, []);

  // Find similar seeds
  const runSimilar = useCallback(async () => {
    if (!currentJewelType || nodesInRadius.length === 0) return;
    const tj = timelessJewels.find(j => String(j.nodeId) === String(selectedSocket));
    if (!tj) return;
    setLoading(true); setError(null);
    try {
      const nodeIds = nodesInRadius.map(n => parseInt(n.nodeId));
      const data = await findSimilarSeeds(currentJewelType.type, tj.parsed.seed, nodeIds, { minMatch: 1, maxResults: 50 });
      setSimilarResults(data);
      setActiveTab('similar');
    } catch (e) { setError(e.message); }
    finally { setLoading(false); }
  }, [currentJewelType, nodesInRadius, timelessJewels, selectedSocket]);

  // Preview a seed's transforms
  const showPreview = useCallback(async (seed) => {
    if (!currentJewelType) return;
    setPreviewSeed(seed);
    try {
      const nodeIds = nodesInRadius.map(n => parseInt(n.nodeId));
      const transforms = await getTransforms(currentJewelType.type, seed, nodeIds);
      setPreviewTransforms(transforms);
      setActiveTab('preview');
    } catch (e) { setError(e.message); }
  }, [currentJewelType, nodesInRadius]);

  // Trade link helper
  const tradeLink = useCallback((seeds) => {
    if (!currentJewelType || !tradeIds) return null;
    return buildTradeUrl(selectedLeague || 'Dawn', currentJewelType.type, selectedConqueror, seeds, tradeIds);
  }, [currentJewelType, selectedConqueror, selectedLeague, tradeIds]);

  if (!passives || !sockets) return <div className="text-xs text-slate-500 p-4 animate-pulse">Loading timeless data...</div>;

  const equippedJewel = timelessJewels.find(j => String(j.nodeId) === String(selectedSocket));
  const notableCount = nodesInRadius.filter(n => n.isNotable).length;

  // Format delta with color
  const DeltaValue = ({ value, suffix = '' }) => {
    const num = typeof value === 'number' ? value : parseFloat(value) || 0;
    if (num === 0) return <span className="text-slate-600">0{suffix}</span>;
    const color = num > 0 ? 'text-emerald-400' : 'text-red-400';
    const prefix = num > 0 ? '+' : '';
    const formatted = Number.isInteger(num) ? num.toLocaleString() : num.toFixed(2);
    return <span className={color}>{prefix}{formatted}{suffix}</span>;
  };

  return (
    <div className="space-y-3">
      {/* Equipped jewel banner */}
      {equippedJewel && (
        <div className="bg-gradient-to-r from-amber-900/20 to-transparent border border-amber-800/30 rounded-xl px-4 py-3">
          <div className="flex items-center gap-3">
            <div className="w-8 h-8 rounded-lg bg-amber-900/40 flex items-center justify-center">
              <span className="text-amber-400 text-sm font-black">T</span>
            </div>
            <div>
              <div className="text-xs font-black text-amber-300">{equippedJewel.parsed.jewelName}</div>
              <div className="text-[10px] text-slate-400">
                Seed <span className="text-amber-400 font-mono">{equippedJewel.parsed.seed}</span>
                {' · '}{equippedJewel.parsed.conquerorName}
                {' · '}{socketList.find(s => String(s.node_id) === String(selectedSocket))?.keystone || ''}
              </div>
            </div>
            <div className="ml-auto flex gap-2">
              <button onClick={runSimilar} disabled={loading || nodesInRadius.length === 0}
                className="text-[9px] font-bold text-cyan-400 bg-cyan-900/20 border border-cyan-800/40 rounded px-2.5 py-1 cursor-pointer hover:bg-cyan-900/30 transition-colors disabled:opacity-30">
                Find Similar
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Search Mode Toggle */}
      <div className="flex gap-1 bg-[#0a0b0e] border border-slate-800 rounded-lg p-1">
        <button onClick={() => setSearchMode('mods')}
          className={`flex-1 text-[9px] font-black uppercase tracking-wider py-1.5 rounded cursor-pointer transition-colors ${
            searchMode === 'mods' ? 'bg-blue-600/20 text-blue-400 border border-blue-800/50' : 'text-slate-600 hover:text-slate-400'
          }`}>By Mods</button>
        <button onClick={() => setSearchMode('dps')}
          className={`flex-1 text-[9px] font-black uppercase tracking-wider py-1.5 rounded cursor-pointer transition-colors ${
            searchMode === 'dps' ? 'bg-purple-600/20 text-purple-400 border border-purple-800/50' : 'text-slate-600 hover:text-slate-400'
          }`}>By DPS/EHP</button>
      </div>

      {/* Config */}
      <div className="bg-[#12141c] border border-slate-800 rounded-xl p-4 space-y-3">
        <div className="grid grid-cols-3 gap-3">
          <div>
            <label className="text-[9px] text-slate-600 block mb-1">Socket</label>
            <select value={selectedSocket} onChange={e => { setSelectedSocket(e.target.value); setResults(null); setSimilarResults(null); setDpsResults(null); }}
              className="w-full bg-[#0a0b0e] border border-slate-800 rounded px-2 py-1.5 text-[10px] text-slate-300 outline-none">
              <option value="">Select...</option>
              {socketList.map(s => {
                const prefix = s.socketedJewel ? `[${s.socketedJewel.jewelName}] ` : '';
                return <option key={s.node_id} value={s.node_id}>{prefix}{s.keystone}</option>;
              })}
            </select>
          </div>
          <div>
            <label className="text-[9px] text-slate-600 block mb-1">Jewel</label>
            <select value={selectedJewelType} onChange={e => { setSelectedJewelType(e.target.value); setResults(null); setDpsResults(null); }}
              className="w-full bg-[#0a0b0e] border border-slate-800 rounded px-2 py-1.5 text-[10px] text-slate-300 outline-none">
              <option value="">Select...</option>
              {Object.keys(JEWEL_TYPES).map(n => <option key={n} value={n}>{n}</option>)}
            </select>
          </div>
          <div>
            <label className="text-[9px] text-slate-600 block mb-1">Conqueror</label>
            <select value={selectedConqueror} onChange={e => setSelectedConqueror(parseInt(e.target.value))}
              className="w-full bg-[#0a0b0e] border border-slate-800 rounded px-2 py-1.5 text-[10px] text-slate-300 outline-none">
              {currentJewelType ? currentJewelType.conquerors.map((c, i) => <option key={i} value={i}>{c}</option>) : <option>—</option>}
            </select>
          </div>
        </div>
        {selectedSocket && (
          <div className="flex items-center justify-between text-[9px]">
            <span className="text-slate-600">{notableCount} notables · {nodesInRadius.length} nodes in radius{allocatedOnly ? ' (allocated)' : ''}</span>
            <label className="flex items-center gap-1.5 cursor-pointer">
              <input type="checkbox" checked={allocatedOnly} onChange={e => { setAllocatedOnly(e.target.checked); setResults(null); setDpsResults(null); }} className="w-3 h-3 accent-blue-500" />
              <span className="text-slate-500">Allocated only</span>
            </label>
          </div>
        )}

        {/* Multi-socket selection (DPS mode only) */}
        {searchMode === 'dps' && socketList.length > 1 && (
          <div className="space-y-1.5">
            <span className="text-[9px] text-slate-600">Multi-socket (optional)</span>
            <div className="flex flex-wrap gap-1.5">
              {socketList.map(s => {
                const isSelected = selectedDpsSockets.has(String(s.node_id));
                return (
                  <button key={s.node_id} onClick={() => toggleDpsSocket(String(s.node_id))}
                    className={`text-[8px] px-2 py-1 rounded border cursor-pointer transition-colors ${
                      isSelected
                        ? 'bg-purple-900/30 border-purple-700/50 text-purple-300'
                        : 'border-slate-800 text-slate-600 hover:text-slate-400'
                    }`}>
                    {s.socketedJewel ? s.socketedJewel.conquerorName : ''} {s.keystone}
                  </button>
                );
              })}
            </div>
          </div>
        )}
      </div>

      {/* DPS/EHP Config (DPS mode) */}
      {searchMode === 'dps' && (
        <div className="bg-[#12141c] border border-slate-800 rounded-xl p-4 space-y-3">
          <span className="text-[9px] font-black text-slate-500 uppercase tracking-widest">DPS/EHP Weights</span>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <div className="flex items-center justify-between mb-1">
                <label className="text-[9px] text-slate-500">DPS Weight</label>
                <span className="text-[10px] text-purple-400 font-mono">{dpsWeight}%</span>
              </div>
              <input type="range" min={0} max={100} value={dpsWeight}
                onChange={e => { const v = parseInt(e.target.value); setDpsWeight(v); setEhpWeight(100 - v); }}
                className="w-full accent-purple-500 h-1" />
            </div>
            <div>
              <div className="flex items-center justify-between mb-1">
                <label className="text-[9px] text-slate-500">EHP Weight</label>
                <span className="text-[10px] text-blue-400 font-mono">{ehpWeight}%</span>
              </div>
              <input type="range" min={0} max={100} value={ehpWeight}
                onChange={e => { const v = parseInt(e.target.value); setEhpWeight(v); setDpsWeight(100 - v); }}
                className="w-full accent-blue-500 h-1" />
            </div>
          </div>
          <div className="flex items-center gap-3 text-[9px]">
            <label className="text-slate-600">Pre-filter seeds</label>
            <input type="number" value={preFilterTop} onChange={e => setPreFilterTop(Math.max(10, Math.min(200, parseInt(e.target.value) || 50)))}
              className="w-14 bg-[#0a0b0e] border border-slate-800 rounded px-2 py-0.5 text-slate-300 outline-none text-center" />
            <span className="text-slate-700">~{Math.round(preFilterTop * 0.1)}s per socket</span>
          </div>

          <button onClick={runDpsSearch}
            disabled={loading || !currentJewelType || !pobCode || (!selectedSocket && selectedDpsSockets.size === 0)}
            className="w-full bg-purple-600/20 hover:bg-purple-600/30 border border-purple-800/50 rounded-lg px-4 py-2.5 text-[10px] font-black text-purple-400 uppercase tracking-wider cursor-pointer disabled:opacity-30 disabled:cursor-not-allowed transition-all"
            title={!pobCode ? 'Load a build first' : ''}>
            {loading ? `Evaluating ${preFilterTop} seeds... ${dpsElapsed}s` : 'Search by DPS/EHP'}
          </button>
          {!pobCode && (
            <div className="text-[9px] text-amber-500/70 text-center">Load a PoB build to use DPS/EHP search</div>
          )}
        </div>
      )}

      {/* Desired Mods (shown in both modes - used as pre-filter hint in DPS mode) */}
      <div className="bg-[#12141c] border border-slate-800 rounded-xl p-4 space-y-3">
        <div className="flex items-center justify-between">
          <span className="text-[9px] font-black text-slate-500 uppercase tracking-widest">
            {searchMode === 'mods' ? 'Desired Mods' : 'Desired Mods (pre-filter hint)'}
          </span>
          {searchMode === 'mods' && (
            <div className="flex items-center gap-2 text-[9px]">
              <span className="text-slate-600">Min score</span>
              <input type="number" value={budgetMin} onChange={e => setBudgetMin(Math.max(0, parseInt(e.target.value) || 0))}
                className="w-10 bg-[#0a0b0e] border border-slate-800 rounded px-1 py-0.5 text-slate-300 outline-none text-center" />
            </div>
          )}
        </div>
        <select onChange={e => { if (e.target.value) { addMod(e.target.value); e.target.value = ''; } }}
          className="w-full bg-[#0a0b0e] border border-slate-800 rounded px-2 py-1.5 text-[10px] text-slate-400 outline-none">
          <option value="">+ Add mod...</option>
          {availableMods.filter(m => !desiredMods.some(d => d.id === m.id)).map(m =>
            <option key={m.id} value={m.id}>{m.dn} — {(m.sd || [])[0] || ''}</option>
          )}
        </select>
        {desiredMods.length > 0 && (
          <div className="space-y-1">
            {desiredMods.map(mod => (
              <div key={mod.id} className="flex items-center gap-2 bg-[#0a0b0e] border border-slate-800/60 rounded px-2.5 py-1.5">
                {searchMode === 'mods' && (
                  <button onClick={() => toggleRequired(mod.id)}
                    className={`text-[8px] w-4 h-4 rounded flex items-center justify-center cursor-pointer shrink-0 font-bold ${
                      mod.required ? 'bg-red-900/50 border border-red-700 text-red-300' : 'border border-slate-700 text-slate-600'
                    }`}>R</button>
                )}
                <span className="text-[10px] text-slate-300 flex-1 truncate">{mod.dn}</span>
                <span className="text-[8px] text-slate-600 max-w-[180px] truncate hidden sm:inline">{(mod.sd || [])[0]}</span>
                <input type="number" value={mod.weight} onChange={e => updateWeight(mod.id, parseInt(e.target.value) || 1)}
                  className="w-10 bg-[#12141c] border border-slate-700 rounded px-1 py-0.5 text-[10px] text-blue-400 outline-none text-center" min={1} max={10} />
                <button onClick={() => removeMod(mod.id)} className="text-slate-600 hover:text-red-400 text-xs cursor-pointer">×</button>
              </div>
            ))}
          </div>
        )}
        {searchMode === 'mods' && (
          <button onClick={runSearch}
            disabled={loading || !selectedSocket || !currentJewelType || desiredMods.length === 0}
            className="w-full bg-blue-600/20 hover:bg-blue-600/30 border border-blue-800/50 rounded-lg px-4 py-2.5 text-[10px] font-black text-blue-400 uppercase tracking-wider cursor-pointer disabled:opacity-30 disabled:cursor-not-allowed transition-all">
            {loading ? 'Searching...' : 'Search All Seeds'}
          </button>
        )}
      </div>

      {error && <div className="bg-red-900/20 border border-red-800/40 rounded-xl p-3 text-xs text-red-400">{error}</div>}

      {/* Results tabs */}
      {(results || similarResults || previewTransforms || dpsResults) && (
        <div className="bg-[#12141c] border border-slate-800 rounded-xl overflow-hidden">
          {/* Tab bar */}
          <div className="flex border-b border-slate-800/50">
            {results && (
              <button onClick={() => setActiveTab('search')}
                className={`px-4 py-2 text-[9px] font-black uppercase cursor-pointer transition-colors ${activeTab === 'search' ? 'text-blue-400 bg-blue-900/20 border-b-2 border-blue-500' : 'text-slate-600 hover:text-slate-400'}`}>
                Search ({results.matchingSeeds})
              </button>
            )}
            {dpsResults && (
              <button onClick={() => setActiveTab('dps')}
                className={`px-4 py-2 text-[9px] font-black uppercase cursor-pointer transition-colors ${activeTab === 'dps' ? 'text-purple-400 bg-purple-900/20 border-b-2 border-purple-500' : 'text-slate-600 hover:text-slate-400'}`}>
                DPS/EHP
              </button>
            )}
            {similarResults && (
              <button onClick={() => setActiveTab('similar')}
                className={`px-4 py-2 text-[9px] font-black uppercase cursor-pointer transition-colors ${activeTab === 'similar' ? 'text-cyan-400 bg-cyan-900/20 border-b-2 border-cyan-500' : 'text-slate-600 hover:text-slate-400'}`}>
                Similar ({similarResults.results.length})
              </button>
            )}
            {previewTransforms && (
              <button onClick={() => setActiveTab('preview')}
                className={`px-4 py-2 text-[9px] font-black uppercase cursor-pointer transition-colors ${activeTab === 'preview' ? 'text-amber-400 bg-amber-900/20 border-b-2 border-amber-500' : 'text-slate-600 hover:text-slate-400'}`}>
                Preview: {previewSeed}
              </button>
            )}
            <div className="ml-auto px-3 py-2 text-[8px] text-slate-600 self-center">
              {activeTab === 'search' && results ? `${results.timing}ms` : ''}
              {activeTab === 'similar' && similarResults ? `${similarResults.timing}ms` : ''}
              {activeTab === 'dps' && dpsElapsed ? `${dpsElapsed}s` : ''}
            </div>
          </div>

          {/* Search results (By Mods) */}
          {activeTab === 'search' && results && (
            <div className="p-4 space-y-2 max-h-[600px] overflow-y-auto">
              {results.results.length === 0 ? (
                <div className="text-xs text-slate-500 text-center py-8">No seeds match. Try fewer required mods or lower minimum score.</div>
              ) : (
                <>
                  {results.results.map((r, ri) => (
                    <div key={r.seed} className="bg-[#0a0b0e] border border-slate-800/60 rounded-lg px-3 py-2 hover:border-slate-700 transition-colors">
                      <div className="flex items-center justify-between mb-1.5">
                        <div className="flex items-center gap-2">
                          <span className="text-[8px] text-slate-600 font-mono w-5">#{ri + 1}</span>
                          <button onClick={() => showPreview(r.seed)} className="text-xs font-bold text-amber-400 hover:text-amber-300 cursor-pointer">
                            Seed {r.seed}
                          </button>
                          <div className="flex items-center gap-1">
                            <div className="h-1.5 rounded-full bg-blue-500/30 overflow-hidden" style={{ width: 60 }}>
                              <div className="h-full bg-blue-500 rounded-full" style={{ width: `${Math.min(100, (r.score / (desiredMods.reduce((s, m) => s + m.weight, 0) * nodesInRadius.filter(n => n.isNotable).length / 3)) * 100)}%` }} />
                            </div>
                            <span className="text-[9px] text-blue-400 font-mono">{r.score}</span>
                          </div>
                        </div>
                        <a href={tradeLink([r.seed]) || '#'} target="_blank" rel="noopener noreferrer"
                          className="text-[8px] font-bold text-emerald-400 hover:text-emerald-300 bg-emerald-900/20 border border-emerald-800/30 rounded px-2 py-0.5 cursor-pointer transition-colors">
                          Trade
                        </a>
                      </div>
                      <div className="flex flex-wrap gap-1">
                        {r.matches.map((m, mi) => (
                          <span key={mi} className={`text-[8px] px-1.5 py-0.5 rounded ${m.isReplacement ? 'bg-amber-900/20 text-amber-300/80' : 'bg-teal-900/20 text-teal-300/80'}`}>
                            {m.dn}
                          </span>
                        ))}
                      </div>
                    </div>
                  ))}
                  {/* Batch trade */}
                  {results.results.length > 1 && (
                    <a href={tradeLink(results.results.slice(0, 10).map(r => r.seed)) || '#'} target="_blank" rel="noopener noreferrer"
                      className="block text-center text-[9px] font-bold text-emerald-400 hover:text-emerald-300 bg-emerald-900/15 border border-emerald-800/30 rounded-lg px-4 py-2.5 cursor-pointer mt-3 transition-colors">
                      Trade: Top {Math.min(10, results.results.length)} Seeds
                    </a>
                  )}
                </>
              )}
            </div>
          )}

          {/* DPS/EHP Results */}
          {activeTab === 'dps' && dpsResults && (
            <div className="p-4 space-y-4 max-h-[600px] overflow-y-auto">
              {/* Baseline */}
              <div className="flex items-center gap-4 text-[9px] text-slate-500 bg-[#0a0b0e] rounded-lg px-3 py-2">
                <span className="font-bold text-slate-400">Baseline</span>
                <span>DPS: <span className="text-slate-300 font-mono">{Math.round(dpsResults.baseline.dps).toLocaleString()}</span></span>
                <span>EHP: <span className="text-slate-300 font-mono">{Math.round(dpsResults.baseline.ehp).toLocaleString()}</span></span>
              </div>

              {/* Best Combo (multi-socket) */}
              {dpsResults.sockets.length > 1 && (
                <div className="bg-gradient-to-r from-purple-900/20 to-transparent border border-purple-800/30 rounded-lg px-3 py-2.5">
                  <div className="text-[9px] font-black text-purple-300 uppercase tracking-wider mb-1.5">Best Combo</div>
                  <div className="space-y-1">
                    {dpsResults.sockets.map(s => {
                      const best = s.results[0];
                      if (!best) return null;
                      const socketInfo = socketList.find(sl => String(sl.node_id) === String(s.socketNodeId));
                      return (
                        <div key={s.socketNodeId} className="flex items-center gap-2 text-[9px]">
                          <span className="text-slate-500 w-24 truncate">{socketInfo?.keystone || s.socketNodeId}</span>
                          <span className="text-amber-400 font-mono">Seed {best.seed}</span>
                          <DeltaValue value={best.dpsPercent} suffix="% DPS" />
                          <DeltaValue value={best.ehpPercent} suffix="% EHP" />
                          <span className="text-purple-400 font-mono ml-auto">{best.score}</span>
                        </div>
                      );
                    })}
                  </div>
                </div>
              )}

              {/* Per-socket results */}
              {dpsResults.sockets.map(socketResult => {
                const socketInfo = socketList.find(sl => String(sl.node_id) === String(socketResult.socketNodeId));
                return (
                  <div key={socketResult.socketNodeId}>
                    {dpsResults.sockets.length > 1 && (
                      <div className="text-[9px] font-black text-slate-500 uppercase tracking-wider mb-2">
                        {socketInfo?.keystone || `Socket ${socketResult.socketNodeId}`}
                      </div>
                    )}
                    {socketResult.error && (
                      <div className="text-[9px] text-red-400 mb-2">{socketResult.error}</div>
                    )}
                    {socketResult.results.length === 0 && !socketResult.error && (
                      <div className="text-[9px] text-slate-500 text-center py-4">No results for this socket.</div>
                    )}
                    <div className="space-y-1.5">
                      {socketResult.results.map((r, ri) => (
                        <div key={r.seed} className="bg-[#0a0b0e] border border-slate-800/60 rounded-lg px-3 py-2 hover:border-slate-700 transition-colors">
                          <div className="flex items-center gap-2 mb-1">
                            <span className="text-[8px] text-slate-600 font-mono w-5">#{ri + 1}</span>
                            <button onClick={() => showPreview(r.seed)} className="text-xs font-bold text-amber-400 hover:text-amber-300 cursor-pointer">
                              Seed {r.seed}
                            </button>
                            <div className="flex items-center gap-3 text-[9px] ml-2">
                              <span className="text-slate-500">DPS <DeltaValue value={r.dpsDelta} /> <span className="text-slate-600">(<DeltaValue value={r.dpsPercent} suffix="%" />)</span></span>
                              <span className="text-slate-500">EHP <DeltaValue value={r.ehpDelta} /> <span className="text-slate-600">(<DeltaValue value={r.ehpPercent} suffix="%" />)</span></span>
                            </div>
                            <span className="text-[9px] text-purple-400 font-mono font-bold ml-auto">{r.score}</span>
                            <a href={tradeLink([r.seed]) || '#'} target="_blank" rel="noopener noreferrer"
                              className="text-[8px] font-bold text-emerald-400 bg-emerald-900/20 border border-emerald-800/30 rounded px-2 py-0.5 cursor-pointer transition-colors">
                              Trade
                            </a>
                          </div>
                          {r.modMatches && r.modMatches.length > 0 && (
                            <div className="flex flex-wrap gap-1">
                              {r.modMatches.map((m, mi) => (
                                <span key={mi} className={`text-[8px] px-1.5 py-0.5 rounded ${m.isReplacement ? 'bg-amber-900/20 text-amber-300/80' : 'bg-teal-900/20 text-teal-300/80'}`}>
                                  {m.dn}
                                </span>
                              ))}
                            </div>
                          )}
                        </div>
                      ))}
                    </div>
                    {/* Batch trade for this socket */}
                    {socketResult.results.length > 1 && (
                      <a href={tradeLink(socketResult.results.slice(0, 10).map(r => r.seed)) || '#'} target="_blank" rel="noopener noreferrer"
                        className="block text-center text-[9px] font-bold text-emerald-400 hover:text-emerald-300 bg-emerald-900/15 border border-emerald-800/30 rounded-lg px-4 py-2 cursor-pointer mt-2 transition-colors">
                        Trade: Top {Math.min(10, socketResult.results.length)} Seeds
                      </a>
                    )}
                  </div>
                );
              })}
            </div>
          )}

          {/* Similar seeds */}
          {activeTab === 'similar' && similarResults && (
            <div className="p-4 space-y-2 max-h-[600px] overflow-y-auto">
              {similarResults.results.length === 0 ? (
                <div className="text-xs text-slate-500 text-center py-8">No similar seeds found.</div>
              ) : (
                similarResults.results.map((r, ri) => {
                  const pct = Math.round((r.matchCount / r.totalNodes) * 100);
                  const matchNodes = r.diff.filter(d => d.same).length;
                  return (
                    <div key={r.seed} className="bg-[#0a0b0e] border border-slate-800/60 rounded-lg px-3 py-2 hover:border-slate-700 transition-colors">
                      <div className="flex items-center justify-between mb-1.5">
                        <div className="flex items-center gap-2">
                          <span className="text-[8px] text-slate-600 font-mono w-5">#{ri + 1}</span>
                          <button onClick={() => showPreview(r.seed)} className="text-xs font-bold text-cyan-400 hover:text-cyan-300 cursor-pointer">
                            Seed {r.seed}
                          </button>
                          <div className="flex items-center gap-1">
                            <div className="h-1.5 w-16 rounded-full bg-cyan-500/20 overflow-hidden">
                              <div className="h-full bg-cyan-500 rounded-full" style={{ width: `${pct}%` }} />
                            </div>
                            <span className="text-[9px] text-cyan-400">{matchNodes}/{r.totalNodes}</span>
                          </div>
                        </div>
                        <a href={tradeLink([r.seed]) || '#'} target="_blank" rel="noopener noreferrer"
                          className="text-[8px] font-bold text-emerald-400 bg-emerald-900/20 border border-emerald-800/30 rounded px-2 py-0.5 cursor-pointer">
                          Trade
                        </a>
                      </div>
                      {/* Compact diff */}
                      <div className="flex flex-wrap gap-0.5">
                        {r.diff.map((d, di) => (
                          <span key={di} className={`text-[7px] px-1 py-px rounded ${d.same ? 'bg-green-900/20 text-green-400/70' : 'bg-red-900/15 text-red-400/50'}`}
                            title={d.same ? d.original.dn : `${d.original.dn} → ${d.alternative?.dn}`}>
                            {d.same ? '✓' : '✗'}
                          </span>
                        ))}
                      </div>
                    </div>
                  );
                })
              )}
            </div>
          )}

          {/* Preview transforms */}
          {activeTab === 'preview' && previewTransforms && (
            <div className="p-4 space-y-1 max-h-[600px] overflow-y-auto">
              <div className="flex items-center justify-between mb-3">
                <div className="text-xs font-black text-amber-400">Seed {previewSeed} Transforms</div>
                <a href={tradeLink([previewSeed]) || '#'} target="_blank" rel="noopener noreferrer"
                  className="text-[9px] font-bold text-emerald-400 bg-emerald-900/20 border border-emerald-800/30 rounded px-2.5 py-1 cursor-pointer">
                  Trade
                </a>
              </div>
              {previewTransforms.map((t, ti) => {
                const nodeInfo = nodesInRadius.find(n => String(n.nodeId) === String(t.nodeId));
                return (
                  <div key={ti} className={`flex items-start gap-2 px-2.5 py-1.5 rounded ${t.isReplacement ? 'bg-amber-900/10' : 'bg-teal-900/10'}`}>
                    <span className={`w-1.5 h-1.5 mt-1.5 rounded-full shrink-0 ${t.isReplacement ? 'bg-amber-400' : t.isKeystone ? 'bg-orange-400' : 'bg-teal-400'}`} />
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-1.5">
                        <span className="text-[9px] text-slate-500">{nodeInfo?.name || t.nodeId}</span>
                        <span className="text-[8px] text-slate-700">→</span>
                        <span className={`text-[10px] font-bold ${t.isReplacement ? 'text-amber-300' : 'text-teal-300'}`}>{t.dn}</span>
                      </div>
                      {t.sd.length > 0 && (
                        <div className="mt-0.5">
                          {t.sd.map((s, si) => <div key={si} className="text-[8px] text-slate-500 leading-snug">{s}</div>)}
                        </div>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
