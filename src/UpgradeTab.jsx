import { useState, useMemo } from 'react';
import { ArrowRight, TrendingUp, Gem, TreePine, Diamond, Swords, Loader2, ChevronDown, ChevronUp } from 'lucide-react';

const CATEGORY_CONFIG = {
  tree: { label: 'Tree', color: 'text-green-400', bg: 'bg-green-900/30', Icon: TreePine },
  jewel: { label: 'Jewel', color: 'text-purple-400', bg: 'bg-purple-900/30', Icon: Diamond },
  gem: { label: 'Gem', color: 'text-blue-400', bg: 'bg-blue-900/30', Icon: Gem },
  item: { label: 'Item', color: 'text-yellow-400', bg: 'bg-yellow-900/30', Icon: Swords },
};

const KEY_STATS = [
  { key: 'MinionTotalDPS', label: 'Minion DPS', fmt: v => formatNumber(v) },
  { key: 'MinionCombinedDPS', label: 'Minion DPS', fmt: v => formatNumber(v) },
  { key: 'TotalEHP', label: 'EHP', fmt: v => formatNumber(v) },
  { key: 'Life', label: 'Life', fmt: v => formatNumber(v) },
  { key: 'MinionLife', label: 'Minion Life', fmt: v => formatNumber(v) },
  { key: 'Armour', label: 'Armour', fmt: v => formatNumber(v) },
];

function formatNumber(n) {
  if (Math.abs(n) >= 1000000) return (n / 1000000).toFixed(1) + 'M';
  if (Math.abs(n) >= 1000) return (n / 1000).toFixed(1) + 'K';
  return Math.round(n).toLocaleString();
}

function DeltaBar({ value, maxAbs, label, pct }) {
  if (!value || Math.abs(value) < 0.1) return null;
  const positive = value > 0;
  const width = maxAbs > 0 ? Math.min(Math.abs(value) / maxAbs * 100, 100) : 0;

  return (
    <div className="flex items-center gap-2 text-[10px]">
      <span className="w-20 text-slate-500 shrink-0">{label}</span>
      <div className="flex-1 h-3 bg-slate-800 rounded-sm relative overflow-hidden">
        <div
          className={`absolute top-0 h-full rounded-sm ${positive ? 'bg-green-600/60 left-1/2' : 'bg-red-600/60 right-1/2'}`}
          style={{ width: `${width / 2}%` }}
        />
      </div>
      <span className={`w-20 text-right font-mono shrink-0 ${positive ? 'text-green-400' : 'text-red-400'}`}>
        {positive ? '+' : ''}{formatNumber(value)}
        {pct != null && <span className="text-[8px] text-slate-500 ml-0.5">({pct > 0 ? '+' : ''}{pct}%)</span>}
      </span>
    </div>
  );
}

function UpgradeCard({ upgrade, maxDps, maxEhp }) {
  const [expanded, setExpanded] = useState(false);
  const cat = CATEGORY_CONFIG[upgrade.category] || CATEGORY_CONFIG.tree;
  const Icon = cat.Icon;

  // Find the most impactful stats for this upgrade
  const dpsKey = upgrade.deltas.MinionCombinedDPS != null ? 'MinionCombinedDPS'
    : upgrade.deltas.MinionTotalDPS != null ? 'MinionTotalDPS' : null;
  const dpsVal = dpsKey ? upgrade.deltas[dpsKey] : 0;
  const dpsPct = dpsKey ? upgrade.pcts[dpsKey] : 0;

  return (
    <div className="bg-[#0a0b0e] border border-slate-800 rounded-lg overflow-hidden">
      <div
        className="px-4 py-3 flex items-center gap-3 cursor-pointer hover:bg-slate-800/30 transition-colors"
        onClick={() => setExpanded(!expanded)}
      >
        <span className={`px-1.5 py-0.5 rounded text-[8px] font-black uppercase ${cat.color} ${cat.bg}`}>
          <Icon size={10} className="inline mr-0.5 -mt-0.5" />
          {cat.label}
        </span>
        <span className="text-[11px] font-semibold text-slate-200 flex-1 truncate">{upgrade.label}</span>
        {dpsVal !== 0 && (
          <span className={`text-[10px] font-mono ${dpsVal > 0 ? 'text-green-400' : 'text-red-400'}`}>
            {dpsVal > 0 ? '+' : ''}{formatNumber(dpsVal)} DPS
          </span>
        )}
        {upgrade.deltas.TotalEHP != null && Math.abs(upgrade.deltas.TotalEHP) > 1 && (
          <span className={`text-[10px] font-mono ${upgrade.deltas.TotalEHP > 0 ? 'text-green-400' : 'text-red-400'}`}>
            {upgrade.deltas.TotalEHP > 0 ? '+' : ''}{formatNumber(upgrade.deltas.TotalEHP)} EHP
          </span>
        )}
        {expanded ? <ChevronUp size={14} className="text-slate-600" /> : <ChevronDown size={14} className="text-slate-600" />}
      </div>

      {expanded && (
        <div className="px-4 pb-3 border-t border-slate-800/50 pt-2 space-y-1">
          <p className="text-[9px] text-slate-500 mb-2">{upgrade.description}</p>
          {Object.entries(upgrade.deltas).map(([key, val]) => {
            const stat = KEY_STATS.find(s => s.key === key);
            const maxAbs = key.includes('DPS') ? maxDps : maxEhp;
            return (
              <DeltaBar
                key={key}
                value={val}
                maxAbs={maxAbs}
                label={stat?.label || key}
                pct={upgrade.pcts[key]}
              />
            );
          })}
          {upgrade.details?.stats && upgrade.details.stats.length > 0 && (
            <div className="mt-1.5 border-t border-slate-800/30 pt-1.5">
              {upgrade.details.stats.map((s, si) => (
                <div key={si} className="text-[9px] text-blue-300/60 leading-tight">{s}</div>
              ))}
            </div>
          )}
          {upgrade.details?.error && (
            <p className="text-[9px] text-red-400/70">Calc error: {upgrade.details.error}</p>
          )}
          {upgrade.note && (
            <p className="text-[8px] text-slate-600 mt-1 italic">{upgrade.note}</p>
          )}
        </div>
      )}
    </div>
  );
}

export default function UpgradeTab({ treeSpecs, pobCode }) {
  const [fromSpec, setFromSpec] = useState(treeSpecs.length > 2 ? treeSpecs.length - 3 : 0);
  const [toSpec, setToSpec] = useState(treeSpecs.length > 1 ? treeSpecs.length - 2 : 0);
  const [loading, setLoading] = useState(false);
  const [progress, setProgress] = useState('');
  const [result, setResult] = useState(null);
  const [error, setError] = useState(null);
  const [sortBy, setSortBy] = useState('dps');
  const [filterCat, setFilterCat] = useState(null);

  async function calculate() {
    if (!pobCode) { setError('No PoB code loaded'); return; }
    setLoading(true);
    setError(null);
    setProgress('Starting...');
    try {
      const res = await fetch('/api/upgrade-plan', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ pobCode, fromSpecIdx: fromSpec, toSpecIdx: toSpec }),
      });
      const data = await res.json();
      if (!data.ok) throw new Error(data.error || 'Calculation failed');
      setResult(data);
    } catch (e) {
      setError(e.message);
    } finally {
      setLoading(false);
      setProgress('');
    }
  }

  // Sort and filter upgrades
  const sortedUpgrades = useMemo(() => {
    if (!result?.upgrades) return [];
    let list = [...result.upgrades];
    if (filterCat) list = list.filter(u => u.category === filterCat);

    list.sort((a, b) => {
      if (sortBy === 'ehp') {
        return Math.abs(b.deltas.TotalEHP || 0) - Math.abs(a.deltas.TotalEHP || 0);
      }
      // Default: sort by DPS impact
      const aDps = Math.abs(a.deltas.MinionCombinedDPS || a.deltas.MinionTotalDPS || 0);
      const bDps = Math.abs(b.deltas.MinionCombinedDPS || b.deltas.MinionTotalDPS || 0);
      return bDps - aDps;
    });
    return list;
  }, [result, sortBy, filterCat]);

  const maxDps = useMemo(() => {
    if (!sortedUpgrades.length) return 1;
    return Math.max(...sortedUpgrades.map(u =>
      Math.abs(u.deltas.MinionCombinedDPS || u.deltas.MinionTotalDPS || 0)
    ), 1);
  }, [sortedUpgrades]);

  const maxEhp = useMemo(() => {
    if (!sortedUpgrades.length) return 1;
    return Math.max(...sortedUpgrades.map(u => Math.abs(u.deltas.TotalEHP || 0)), 1);
  }, [sortedUpgrades]);

  // Category counts
  const catCounts = useMemo(() => {
    if (!result?.upgrades) return {};
    const counts = {};
    for (const u of result.upgrades) {
      counts[u.category] = (counts[u.category] || 0) + 1;
    }
    return counts;
  }, [result]);

  if (!treeSpecs || treeSpecs.length < 2) {
    return (
      <div className="text-center text-slate-500 text-xs py-12">
        Need at least 2 tree specs to compare. Load a PoB code with multiple progression specs.
      </div>
    );
  }

  return (
    <div className="space-y-4">
      {/* Spec selector */}
      <div className="bg-[#12141c] border border-slate-800 rounded-2xl p-4">
        <div className="flex items-center gap-3 flex-wrap">
          <div className="flex items-center gap-2">
            <span className="text-[9px] font-black text-slate-500 uppercase">From</span>
            <select
              value={fromSpec}
              onChange={e => setFromSpec(+e.target.value)}
              className="bg-[#0a0b0e] border border-slate-800 rounded-lg px-2 py-1.5 text-[10px] text-blue-400 outline-none min-w-[200px]"
            >
              {treeSpecs.map((s, i) => <option key={i} value={i}>{s.title}</option>)}
            </select>
          </div>
          <ArrowRight size={14} className="text-slate-600" />
          <div className="flex items-center gap-2">
            <span className="text-[9px] font-black text-slate-500 uppercase">To</span>
            <select
              value={toSpec}
              onChange={e => setToSpec(+e.target.value)}
              className="bg-[#0a0b0e] border border-slate-800 rounded-lg px-2 py-1.5 text-[10px] text-blue-400 outline-none min-w-[200px]"
            >
              {treeSpecs.map((s, i) => <option key={i} value={i}>{s.title}</option>)}
            </select>
          </div>
          <button
            onClick={calculate}
            disabled={loading || fromSpec === toSpec}
            className="bg-blue-600 hover:bg-blue-500 disabled:bg-slate-700 disabled:text-slate-500 text-white text-xs font-bold px-4 py-1.5 rounded-lg transition-colors cursor-pointer"
          >
            {loading ? (
              <span className="flex items-center gap-1.5">
                <Loader2 size={12} className="animate-spin" />
                {progress || 'Calculating...'}
              </span>
            ) : (
              'Calculate Upgrades'
            )}
          </button>
        </div>
        {error && <p className="text-xs text-red-400 mt-2">{error}</p>}
      </div>

      {/* Summary banner */}
      {result && (
        <div className="bg-[#12141c] border border-slate-800 rounded-2xl p-4">
          <div className="flex items-center justify-between mb-3">
            <span className="text-[9px] font-black text-slate-500 uppercase tracking-widest">
              Upgrade Summary ({result.upgrades.length} changes, {(result.timing.totalMs / 1000).toFixed(1)}s)
            </span>
            <div className="flex gap-2">
              <select
                value={sortBy}
                onChange={e => setSortBy(e.target.value)}
                className="bg-[#0a0b0e] border border-slate-800 rounded px-2 py-0.5 text-[9px] text-slate-400 outline-none"
              >
                <option value="dps">Sort: DPS Impact</option>
                <option value="ehp">Sort: EHP Impact</option>
              </select>
            </div>
          </div>

          {/* Baseline → Target summary */}
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 mb-3">
            {[
              { label: 'Minion DPS', from: result.baseline.MinionCombinedDPS || result.baseline.MinionTotalDPS, to: result.target.MinionCombinedDPS || result.target.MinionTotalDPS },
              { label: 'EHP', from: result.baseline.TotalEHP, to: result.target.TotalEHP },
              { label: 'Life', from: result.baseline.Life, to: result.target.Life },
              { label: 'Minion Life', from: result.baseline.MinionLife, to: result.target.MinionLife },
            ].map(({ label, from, to }) => {
              const fv = parseFloat(from || '0');
              const tv = parseFloat(to || '0');
              const delta = tv - fv;
              return (
                <div key={label} className="bg-[#0a0b0e] rounded-lg px-3 py-2">
                  <div className="text-[8px] text-slate-600 uppercase">{label}</div>
                  <div className="text-[11px] text-slate-300 font-mono">{formatNumber(fv)} → {formatNumber(tv)}</div>
                  {Math.abs(delta) > 0.1 && (
                    <div className={`text-[10px] font-mono ${delta > 0 ? 'text-green-400' : 'text-red-400'}`}>
                      {delta > 0 ? '+' : ''}{formatNumber(delta)}
                    </div>
                  )}
                </div>
              );
            })}
          </div>

          {/* Category filter */}
          <div className="flex gap-1.5 mb-3">
            <button
              onClick={() => setFilterCat(null)}
              className={`px-2 py-0.5 rounded text-[9px] font-bold transition-all cursor-pointer ${!filterCat ? 'bg-blue-900/40 text-blue-300 border border-blue-700' : 'bg-[#0a0b0e] text-slate-500 border border-slate-800 hover:text-slate-300'}`}
            >
              All ({result.upgrades.length})
            </button>
            {Object.entries(catCounts).map(([cat, count]) => {
              const cfg = CATEGORY_CONFIG[cat] || {};
              return (
                <button
                  key={cat}
                  onClick={() => setFilterCat(filterCat === cat ? null : cat)}
                  className={`px-2 py-0.5 rounded text-[9px] font-bold transition-all cursor-pointer ${filterCat === cat ? `${cfg.bg} ${cfg.color} border border-current` : 'bg-[#0a0b0e] text-slate-500 border border-slate-800 hover:text-slate-300'}`}
                >
                  {cfg.label || cat} ({count})
                </button>
              );
            })}
          </div>

          {/* Upgrade cards */}
          <div className="space-y-1.5">
            {sortedUpgrades.map(u => (
              <UpgradeCard key={u.id} upgrade={u} maxDps={maxDps} maxEhp={maxEhp} />
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
