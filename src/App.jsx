import { useState, useEffect, useRef } from 'react';
import pako from 'pako';
import {
  AlertTriangle, Clock, Loader2, Activity, TrendingUp,
  ChevronDown, ChevronUp,
} from 'lucide-react';
import { createTradeSearch, getTradeResultUrl, buildTradeQuery, searchGemTrade, fetchWeights, fetchWeightsBatch, fetchSlotWeights, toPobSlotName, parseGggItems } from './tradeApi';
import { getGemSource } from './gemVendors';
import PassiveTree, { decodeTreeUrl, fetchTreeData } from './PassiveTree';
import * as api from './api';
import {
  CLASS_NAMES, ASCENDANCY_NAMES, getBuildInfo, getMainSkill,
  GEM_COLORS, getGemColor, parseGemSetups, SLOT_ORDER,
  getItemCategory, loadHistory, saveHistory,
} from './constants';

// Components
import Header from './Header';
import GemsTab from './GemsTab';
import CompareTab from './CompareTab';
import ItemsTab from './ItemsTab';
import StagesTab from './StagesTab';
import UpgradeTab from './UpgradeTab';
import GearAudit from './GearAudit';
import TimelessSearch from './TimelessSearch';

export default function App() {
  // --- All state (unchanged from original) ---
  const [recentBuilds, setRecentBuilds] = useState(() => loadHistory());
  const [pobCode, setPobCode] = useState(() => {
    try { return localStorage.getItem('pob-trade-lastcode') || ''; } catch { return ''; }
  });
  const [pobbinUrl, setPobbinUrl] = useState(() => {
    try { return localStorage.getItem('pob-trade-pobbinurl') || ''; } catch { return ''; }
  });
  const [leagues, setLeagues] = useState(['Standard', 'Hardcore']);
  const [selectedLeague, setSelectedLeague] = useState(() => {
    try { return localStorage.getItem('pob-trade-league') || 'Standard'; } catch { return 'Standard'; }
  });
  const [groupedItems, setGroupedItems] = useState({});
  const [activeCategory, setActiveCategory] = useState(() => {
    try { return localStorage.getItem('pob-trade-itemset') || ''; } catch { return ''; }
  });
  const [collapsedSubGroups, setCollapsedSubGroups] = useState(() => {
    try {
      const saved = localStorage.getItem('pob-trade-tabs');
      return saved ? JSON.parse(saved) : { Equipment: true, 'Skill Gems': true, Flasks: true, Jewels: true };
    } catch { return { Equipment: true, 'Skill Gems': true, Flasks: true, Jewels: true }; }
  });
  const [isProcessing, setIsProcessing] = useState(false);
  const [feedbackId, setFeedbackId] = useState(null);
  const [searchingItems, setSearchingItems] = useState({});
  const [error, setError] = useState(null);
  const [buildClass, setBuildClass] = useState(null);
  const [gemSetups, setGemSetups] = useState([]);
  const [selectedSetupIdx, setSelectedSetupIdx] = useState(0);
  const [treeSpecs, setTreeSpecs] = useState([]);
  const [treeData, setTreeData] = useState(null);
  const [slotGems, setSlotGems] = useState({});
  const [showSettings, setShowSettings] = useState(false);
  const [hasSession, setHasSession] = useState(false);
  const [cfReady, setCfReady] = useState(false);
  const [sessionInput, setSessionInput] = useState('');
  const [accountName, setAccountName] = useState(() => {
    try { return localStorage.getItem('pob-trade-account') || null; } catch { return null; }
  });
  const [loginPending, setLoginPending] = useState(false);
  const [excludedMods, setExcludedMods] = useState({});
  const [debugItem, setDebugItem] = useState(null);
  const [leagueStartOpen, setLeagueStartOpen] = useState(false);
  const [pobStatus, setPobStatus] = useState(null);
  const [itemWeights, setItemWeights] = useState({});
  const [calcingWeights, setCalcingWeights] = useState({});
  const [compareMode, setCompareMode] = useState(false);
  const [compareChars, setCompareChars] = useState([]);
  const [compareChar, setCompareChar] = useState(() => {
    try { return localStorage.getItem('pob-trade-char') || ''; } catch { return ''; }
  });
  const [compareItems, setCompareItems] = useState({});
  const [compareResults, setCompareResults] = useState({});
  const [compareLoading, setCompareLoading] = useState(false);
  const [compareProgress, setCompareProgress] = useState('');

  // Tab state (new)
  const [activeTab, setActiveTab] = useState('items');

  // --- All effects (unchanged) ---
  useEffect(() => {
    api.onLoginState((data) => {
      setHasSession(data.loggedIn);
      if (data.accountName) {
        setAccountName(data.accountName);
        try { localStorage.setItem('pob-trade-account', data.accountName); } catch {}
      }
      setLoginPending(false);
      setShowSettings(false);
    });
  }, []);

  useEffect(() => {
    (async () => {
      try {
        const [leagueRes, configRes] = await Promise.allSettled([
          fetch('https://api.pathofexile.com/leagues?type=main'),
          api.getConfig(),
        ]);
        if (leagueRes.status === 'fulfilled' && leagueRes.value.ok) {
          const data = await leagueRes.value.json();
          const permanent = ['Standard', 'Hardcore', 'Ruthless', 'Hardcore Ruthless'];
          const active = data.filter(l => !l.id.includes('SSF') && !l.id.includes('Solo')).map(l => l.id);
          setLeagues(active);
          const saved = localStorage.getItem('pob-trade-league');
          if (saved && active.includes(saved)) setSelectedLeague(saved);
          else {
            const newest = active.find(l => !permanent.includes(l) && !l.includes('Ruthless')) || active[0];
            setSelectedLeague(newest);
          }
        }
        if (configRes.status === 'fulfilled') {
          const cfg = configRes.value;
          setHasSession(cfg.loggedIn || cfg.hasSession);
          setCfReady(cfg.cfReady);
          if (cfg.accountName) {
            setAccountName(cfg.accountName);
            try { localStorage.setItem('pob-trade-account', cfg.accountName); } catch {}
          }
          if (!cfg.loggedIn && !cfg.hasSession) setShowSettings(true);
        }
      } catch {}
    })();
  }, []);

  useEffect(() => {
    async function checkPob() {
      try { const res = await fetch('/api/pob-status'); if (res.ok) setPobStatus(await res.json()); } catch { setPobStatus(null); }
    }
    checkPob();
    const iv = setInterval(checkPob, 30000);
    return () => clearInterval(iv);
  }, []);

  // --- All handlers (unchanged) ---
  async function calcWeights(item, itemId) {
    const code = localStorage.getItem('pob-trade-lastcode');
    if (!code || !item.slotName) return;
    setCalcingWeights(prev => ({ ...prev, [itemId]: true }));
    try {
      const pobSlot = toPobSlotName(item.slotName);
      const modLines = item.stats.filter(s => !/ \(implicit\)/i.test(s.rawLine)).map(s =>
        s.rawLine.replace(/\{[^}]*\}/g, '').replace(/ \(enchant\)| \(crafted\)| \(fractured\)| \(Searing Exarch\)| \(Eater of Worlds\)/gi, '').trim()
      );
      const result = await fetchWeights(code, pobSlot, modLines);
      if (result?.weights) setItemWeights(prev => ({ ...prev, [itemId]: result }));
    } catch (e) { console.error('Weight calc failed:', e); }
    finally { setCalcingWeights(prev => ({ ...prev, [itemId]: false })); }
  }

  async function calcAllWeights(groups) {
    const code = localStorage.getItem('pob-trade-lastcode');
    if (!code) return;
    const source = groups || groupedItems;
    const batch = [];
    for (const [title, cats] of Object.entries(source)) {
      const equipItems = cats['Equipment'] || [];
      for (let idx = 0; idx < equipItems.length; idx++) {
        const item = equipItems[idx];
        if (!item.slotName) continue;
        const itemId = `${title}:Equipment-${idx}`;
        const pobSlot = toPobSlotName(item.slotName);
        const modLines = item.stats.filter(s => !/ \(implicit\)/i.test(s.rawLine)).map(s =>
          s.rawLine.replace(/\{[^}]*\}/g, '').replace(/ \(enchant\)| \(crafted\)| \(fractured\)| \(Searing Exarch\)| \(Eater of Worlds\)/gi, '').trim()
        );
        batch.push({ itemId, slotName: pobSlot, modLines });
        setCalcingWeights(prev => ({ ...prev, [itemId]: true }));
      }
    }
    if (batch.length === 0) return;
    try {
      const slots = batch.map(b => ({ slotName: b.slotName, modLines: b.modLines }));
      const results = await fetchWeightsBatch(code, slots);
      if (!results) return;
      const newWeights = {};
      for (const b of batch) { const r = results[b.slotName]; if (r?.weights) newWeights[b.itemId] = r; }
      setItemWeights(prev => ({ ...prev, ...newWeights }));
      try { const s = await fetch('/api/pob-status'); if (s.ok) setPobStatus(await s.json()); } catch {}
    } catch (e) { console.error('Batch weight calc failed:', e); }
    finally {
      const clear = {};
      for (const b of batch) clear[b.itemId] = false;
      setCalcingWeights(prev => ({ ...prev, ...clear }));
    }
  }

  const lastWeightedBuild = useRef(null);
  useEffect(() => {
    const code = localStorage.getItem('pob-trade-lastcode');
    if (!code) return;
    if (Object.keys(groupedItems).length === 0) return;
    if (lastWeightedBuild.current === code) return;
    lastWeightedBuild.current = code;
    setItemWeights({});
    calcAllWeights(groupedItems);
  }, [groupedItems]);

  async function loadCompareChars() {
    const name = (accountName || '').trim();
    if (!name) return;
    try {
      const chars = await api.fetchCharacters(name);
      const list = Array.isArray(chars) ? chars : [];
      setCompareChars(list);
      if (list.length === 0) setError('No characters found for that account.');
    } catch (e) { console.error('Failed to fetch characters:', e); setError('Character lookup failed: ' + e.message); }
  }

  useEffect(() => {
    if (accountName?.trim() && compareChars.length === 0) loadCompareChars();
  }, [accountName]);

  async function loadCharacterItems(charName) {
    if (!charName || !accountName) return;
    try {
      const data = await api.fetchCharacterItems(accountName, charName);
      const parsed = parseGggItems(data.items || []);
      setCompareItems(parsed);
      return parsed;
    } catch (e) { console.error('Failed to fetch items:', e); setError('Failed to fetch character items: ' + e.message); return null; }
  }

  async function runComparison(charName) {
    const code = localStorage.getItem('pob-trade-lastcode');
    if (!code || !charName) return;
    setCompareLoading(true); setCompareResults({}); setCompareProgress('Fetching items...');
    try {
      const parsed = await loadCharacterItems(charName);
      if (!parsed) return;
      const batchSlots = [];
      for (const [slot, item] of Object.entries(parsed)) {
        if (item.mods && item.mods.length > 0) batchSlots.push({ slotName: slot, modLines: item.mods });
      }
      setCompareProgress(`Calculating ${batchSlots.length} slots...`);
      const res = await fetch('/api/compare', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ pobCode: code, slots: batchSlots }),
      });
      if (!res.ok) throw new Error(`Compare API ${res.status}`);
      setCompareResults(await res.json());
      setCompareProgress('');
    } catch (e) { console.error('Compare failed:', e); setError('Compare failed: ' + e.message); }
    finally { setCompareLoading(false); }
  }

  const autoLoadedRef = useRef(false);
  useEffect(() => {
    if (autoLoadedRef.current) return;
    autoLoadedRef.current = true;
    const lastCode = localStorage.getItem('pob-trade-lastcode');
    if (lastCode) processPoB(lastCode);
  }, []);

  async function saveSession() {
    if (!sessionInput.trim()) return;
    try {
      const res = await fetch('/api/config', {
        method: 'PUT', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ poesessid: sessionInput.trim() }),
      });
      if (res.ok) { setHasSession(true); setShowSettings(false); setSessionInput(''); }
    } catch (e) { setError('Failed to save session: ' + e.message); }
  }

  function copyToClipboard(text, id) {
    navigator.clipboard.writeText(text).then(() => {
      setFeedbackId(id);
      setTimeout(() => setFeedbackId(null), 2000);
    }).catch(console.error);
  }

  async function processPoB(codeOverride) {
    let target = codeOverride || pobCode;
    if (!target) return;
    target = target.trim();

    const pobbinMatch = target.match(/pobb\.in\/([A-Za-z0-9_-]+)/);
    if (pobbinMatch) {
      const url = `https://pobb.in/${pobbinMatch[1]}`;
      setPobbinUrl(url);
      try { localStorage.setItem('pob-trade-pobbinurl', url); } catch {}
      const lastCode = localStorage.getItem('pob-trade-lastcode');
      if (lastCode && buildClass) { setPobCode(lastCode); setIsProcessing(false); return; }
      window.open(url, '_blank');
      setError('pobb.in link saved! Copy the PoB export code from the site and paste it here.');
      setIsProcessing(false);
      return;
    }

    setIsProcessing(true); setError(null);
    try {
      try { localStorage.setItem('pob-trade-lastcode', target); } catch {}
      const base64 = target.trim().replace(/-/g, '+').replace(/_/g, '/');
      const bytes = new Uint8Array(atob(base64).split('').map(c => c.charCodeAt(0)));
      const inflated = pako.inflate(bytes, { to: 'string' });
      const xmlDoc = new DOMParser().parseFromString(inflated, "text/xml");

      const itemsMap = {};
      Array.from(xmlDoc.getElementsByTagName("Item")).forEach(node => {
        const id = node.getAttribute('id');
        const raw = node.textContent.trim();
        const lines = raw.split('\n').map(l => l.trim()).filter(l => l.length > 0);
        const rarityRaw = (lines[0].match(/Rarity: (\w+)/i) || [null, "Normal"])[1];
        const rarity = rarityRaw.charAt(0).toUpperCase() + rarityRaw.slice(1).toLowerCase();

        // Extract selected variants for filtering {variant:N} tagged mods
        const itemVariant = node.getAttribute('variant');
        const itemVariantAlt = node.getAttribute('variantAlt');
        const itemVariantAlt2 = node.getAttribute('variantAlt2');
        const activeVariants = new Set();
        if (itemVariant) activeVariants.add(itemVariant);
        if (itemVariantAlt) activeVariants.add(itemVariantAlt);
        if (itemVariantAlt2) activeVariants.add(itemVariantAlt2);

        const isMetadata = (l) => /^(Unique ID|Item Level|Quality|Sockets|LevelReq|Implicits|Variant|Selected Variant|Has Alt Variant|Has Alt Variant Two|League|Source|Crafted|Prefix|Suffix|Talisman Tier|Elder Item|Shaper Item|Fractured Item|Synthesised Item|Searing Exarch Item|Eater of Worlds Item|Radius|Limited to|Cluster Jewel|Catalyst|CatalystQuality):/.test(l) || /^[0-9a-f]{32,}$/i.test(l);

        let name, baseType;
        if (['Unique', 'Rare'].includes(rarity)) {
          name = lines[1] || "Unknown Item";
          baseType = '';
          for (let i = 2; i < Math.min(lines.length, 6); i++) {
            if (!isMetadata(lines[i]) && !lines[i].startsWith('---')) { baseType = lines[i]; break; }
          }
        } else { name = lines[1] || "Unknown Item"; baseType = lines[1] || ""; }

        const properties = {};
        const propPatterns = {
          'Armour': /^Armour:\s*(\d+)/, 'Evasion': /^Evasion Rating:\s*(\d+)|^Evasion:\s*(\d+)/,
          'Energy Shield': /^Energy Shield:\s*(\d+)/, 'Physical Damage': /^Physical Damage:\s*(\d+)-(\d+)/,
          'Elemental Damage': /^Elemental Damage:\s*(.+)/, 'Critical Strike Chance': /^Critical Strike Chance:\s*([\d.]+)/,
          'Attacks per Second': /^Attacks per Second:\s*([\d.]+)/, 'Weapon Range': /^Weapon Range:\s*(\d+)/,
        };
        for (const line of lines) {
          for (const [key, regex] of Object.entries(propPatterns)) {
            const m = line.match(regex);
            if (m) {
              if (key === 'Physical Damage') properties[key] = `${m[1]}-${m[2]}`;
              else properties[key] = m[1] || m[2];
            }
          }
        }

        const stats = [];
        const propLines = /^(Armour|Evasion Rating|Evasion|Energy Shield|Physical Damage|Elemental Damage|Critical Strike Chance|Attacks per Second|Weapon Range|Chance to Block|Block):\s/;
        const flaskPropLines = /^(Lasts \d|Consumes \d|Currently has \d|Charges per use)/i;
        const bareMetadata = /^(Elder Item|Shaper Item|Fractured Item|Synthesised Item|Searing Exarch Item|Eater of Worlds Item|Corrupted)$/i;
        lines.forEach((line, idx) => {
          if (idx < 3 || line.startsWith('---') || line.length < 3) return;
          if (line.startsWith('<ModRange')) return;
          if (isMetadata(line)) return;
          if (bareMetadata.test(line)) return;
          if (propLines.test(line)) return;
          if (flaskPropLines.test(line)) return;
          let modTag = null;
          let cleanLine = line;
          if (line.includes('{')) {
            // Filter variant-specific mods: only include if variant matches selected
            const variantMatch = line.match(/\{variant:(\d+)\}/);
            if (variantMatch && activeVariants.size > 0 && !activeVariants.has(variantMatch[1])) return;
            if (/\{exarch\}/i.test(line)) modTag = 'exarch';
            else if (/\{eater\}/i.test(line)) modTag = 'eater';
            else if (/\{crafted\}/i.test(line)) modTag = 'crafted';
            cleanLine = line.replace(/\{[^}]*\}/g, '').trim();
            if (!cleanLine || cleanLine.length < 3) return;
            if (/^(Prefix|Suffix|None)/.test(cleanLine)) return;
          }
          if (cleanLine.includes(':') && !['Resistance', 'Life', 'Mana', 'Energy Shield', 'Strength', 'Dexterity', 'Intelligence'].some(s => cleanLine.includes(s))) return;
          const displayLine = cleanLine.replace(/ \(enchant\)| \(implicit\)| \(crafted\)| \(fractured\)| \(Searing Exarch\)| \(Eater of Worlds\)/gi, '').trim();
          if (!modTag && / \(crafted\)$/i.test(cleanLine)) modTag = 'crafted';
          stats.push({ line: displayLine, rawLine: cleanLine, modTag });
        });
        stats.sort((a, b) => {
          const order = { exarch: 0, eater: 1, null: 2, crafted: 3 };
          return (order[a.modTag] ?? 2) - (order[b.modTag] ?? 2);
        });
        const iLvlMatch = raw.match(/Item Level:\s*(\d+)/);
        const itemLevel = iLvlMatch ? parseInt(iLvlMatch[1]) : null;
        itemsMap[id] = { id, rarity, name, baseType, stats, properties, raw, itemLevel,
          fractured: /Fractured Item/i.test(raw), synthesised: /Synthesised Item/i.test(raw),
          elderItem: /Elder Item/i.test(raw), shaperItem: /Shaper Item/i.test(raw),
          searingExarchItem: /Searing Exarch Item/i.test(raw), eaterOfWorldsItem: /Eater of Worlds Item/i.test(raw),
        };
      });

      const groups = {};
      Array.from(xmlDoc.getElementsByTagName("ItemSet")).forEach(setNode => {
        const title = setNode.getAttribute('title') || "Default";
        const sub = { Equipment: [], 'Skill Gems': [], Flasks: [], Jewels: [] };
        Array.from(setNode.getElementsByTagName("Slot")).forEach(slot => {
          const item = itemsMap[slot.getAttribute('itemId')];
          if (item) {
            const slotName = slot.getAttribute('name') || '';
            const cat = getItemCategory(item, slotName);
            if (cat && !sub[cat].find(i => i.id === item.id)) sub[cat].push({ ...item, slotName });
          }
        });
        groups[title] = sub;
      });
      if (Object.keys(groups).length === 0) {
        const sub = { Equipment: [], 'Skill Gems': [], Flasks: [], Jewels: [] };
        Array.from(xmlDoc.getElementsByTagName("Slot")).forEach(slot => {
          const item = itemsMap[slot.getAttribute('itemId')];
          if (item) {
            const slotName = slot.getAttribute('name') || '';
            const cat = getItemCategory(item, slotName);
            if (cat && !sub[cat].find(i => i.id === item.id)) sub[cat].push({ ...item, slotName });
          }
        });
        groups["Default"] = sub;
      }
      const sortBySlot = (a, b) => (SLOT_ORDER[a.slotName] ?? 99) - (SLOT_ORDER[b.slotName] ?? 99);
      for (const title of Object.keys(groups)) {
        for (const cat of Object.keys(groups[title])) groups[title][cat].sort(sortBySlot);
      }
      setGroupedItems(groups);

      const initExcluded = {};
      for (const title of Object.keys(groups)) {
        for (const cat of Object.keys(groups[title])) {
          groups[title][cat].forEach((item, idx) => {
            const itemId = `${title}:${cat}-${idx}`;
            const offIndices = new Set();
            item.stats.slice(0, 8).forEach((s, i) => {
              if (s.modTag === 'exarch' || s.modTag === 'eater' || s.modTag === 'crafted') offIndices.add(i);
            });
            if (offIndices.size > 0) initExcluded[itemId] = offIndices;
          });
        }
      }
      setExcludedMods(initExcluded);

      const keys = Object.keys(groups);
      const savedCat = localStorage.getItem('pob-trade-itemset');
      setActiveCategory(savedCat && keys.includes(savedCat) ? savedCat : keys[0] || '');

      const buildInfo = getBuildInfo(xmlDoc);
      setBuildClass(buildInfo);
      const setups = parseGemSetups(xmlDoc);

      const activeSkillSetId = xmlDoc.getElementsByTagName("Skills")[0]?.getAttribute("activeSkillSet") || "1";
      const skillSetsXml = Array.from(xmlDoc.getElementsByTagName("SkillSet"));
      const enrichedSetups = setups.map((setup, i) => {
        const isActive = skillSetsXml[i]?.getAttribute("id") === activeSkillSetId;
        const grps = setup.groups.map(group => {
          const gems = group.gems.map(g => {
            const src = getGemSource(g.name, buildInfo.className, setup.isEarlyGame);
            return { ...g, source: src.text, sourceDetail: src.detail, color: getGemColor(g.name) };
          });
          return { ...group, gems };
        });
        return { ...setup, groups: grps, isActive };
      });
      setGemSetups(enrichedSetups);

      const savedGemIdx = parseInt(localStorage.getItem('pob-trade-gemsetup') || '-1');
      const activeIdx = enrichedSetups.findIndex(s => s.isActive);
      const chosenIdx = savedGemIdx >= 0 && savedGemIdx < enrichedSetups.length ? savedGemIdx : (activeIdx >= 0 ? activeIdx : 0);
      setSelectedSetupIdx(chosenIdx);
      setSlotGems(enrichedSetups[chosenIdx]?.groups || []);

      const parsedTreeSpecs = [];
      for (const specEl of Array.from(xmlDoc.getElementsByTagName("Spec"))) {
        const urlText = specEl.getElementsByTagName("URL")[0]?.textContent?.trim();
        if (!urlText) continue;
        const decoded = decodeTreeUrl(urlText);
        if (!decoded || decoded.nodes.size === 0) continue;
        const title = specEl.getAttribute("title") || `Tree ${parsedTreeSpecs.length + 1}`;
        const masteryStr = specEl.getAttribute("masteryEffects") || "";
        const masterySelections = {};
        for (const m of masteryStr.matchAll(/\{(\d+),(\d+)\}/g)) masterySelections[m[1]] = parseInt(m[2]);
        // Parse jewel sockets from <Sockets> element
        const jewelSockets = {};
        const socketsEl = specEl.getElementsByTagName("Sockets")[0];
        if (socketsEl) {
          for (const socketEl of Array.from(socketsEl.getElementsByTagName("Socket"))) {
            const nodeId = socketEl.getAttribute("nodeId");
            const itemId = socketEl.getAttribute("itemId");
            if (nodeId && itemId && itemsMap[itemId]) {
              jewelSockets[nodeId] = itemsMap[itemId];
            }
          }
        }
        // Parse tattoo overrides from <Overrides> element
        const tattoos = {};
        const overridesEl = specEl.getElementsByTagName("Overrides")[0];
        if (overridesEl) {
          for (const overrideEl of Array.from(overridesEl.getElementsByTagName("Override"))) {
            const nodeId = overrideEl.getAttribute("nodeId");
            const dn = overrideEl.getAttribute("dn") || '';
            if (!nodeId || !dn) continue;
            const stats = overrideEl.textContent.trim().split('\n').map(l => l.trim()).filter(Boolean);
            tattoos[nodeId] = { dn, stats, icon: overrideEl.getAttribute("icon") || '' };
          }
        }
        parsedTreeSpecs.push({ title, nodes: decoded.nodes, masterySelections, jewelSockets, tattoos });
      }
      setTreeSpecs(parsedTreeSpecs);
      // Load GGG tree data for TimelessSearch (reuses PassiveTree cache)
      fetchTreeData().then(d => setTreeData(d)).catch(() => {});

      // Inject tree-socketed jewels from the ACTIVE spec (not the last one)
      const treeEl = xmlDoc.getElementsByTagName("Tree")[0];
      const activeSpecIdx = treeEl ? parseInt(treeEl.getAttribute("activeSpec") || "1") - 1 : parsedTreeSpecs.length - 1;
      const bestSpec = parsedTreeSpecs[Math.min(activeSpecIdx, parsedTreeSpecs.length - 1)] || null;
      if (bestSpec?.jewelSockets) {
        const treeJewels = Object.entries(bestSpec.jewelSockets).map(([nodeId, item]) => ({
          ...item,
          slotName: `Tree Socket ${nodeId}`,
          isTreeJewel: true,
        }));
        for (const title of Object.keys(groups)) {
          const existing = groups[title].Jewels || [];
          const existingIds = new Set(existing.map(j => j.id));
          for (const tj of treeJewels) {
            if (!existingIds.has(tj.id)) {
              existing.push(tj);
              existingIds.add(tj.id);
            }
          }
          groups[title].Jewels = existing;
        }
        // Re-set grouped items with injected jewels
        setGroupedItems({...groups});
      }

      fetch('/api/save-pob', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ pobCode: target }) }).catch(() => {});

      if (!codeOverride) {
        const skillName = getMainSkill(xmlDoc);
        const updated = [
          { skillName, pobCode: target, pobbinUrl: pobbinUrl || undefined, timestamp: Date.now() },
          ...recentBuilds.filter(b => b.pobCode !== target)
        ].slice(0, 5);
        setRecentBuilds(updated);
        saveHistory(updated);
      }
    } catch (e) {
      console.error("Process error", e);
      setError("Failed to decode PoB string. Make sure you're pasting a valid export code.");
    } finally { setIsProcessing(false); }
  }

  function createPobbin() {
    const code = localStorage.getItem('pob-trade-lastcode');
    if (!code) return;
    navigator.clipboard.writeText(code).then(() => {
      window.open('https://pobb.in', '_blank');
      setFeedbackId('pobbin-copied');
      setTimeout(() => setFeedbackId(null), 3000);
    }).catch(() => window.open('https://pobb.in', '_blank'));
  }

  async function openTrade(item, itemId, useWeights = false) {
    if (!hasSession) { setShowSettings(true); setError("Log in with Path of Exile first — required for trade searches."); return; }
    setSearchingItems(prev => ({ ...prev, [itemId]: true }));
    try {
      const excluded = excludedMods[itemId] || new Set();
      const filteredStats = item.stats.filter((_, i) => !excluded.has(i));
      const tradeItem = { ...item, stats: filteredStats.map(s => s.rawLine) };
      let weights = null;
      if (useWeights) {
        const code = localStorage.getItem('pob-trade-lastcode');
        if (code && item.slotName) weights = await fetchSlotWeights(code, toPobSlotName(item.slotName));
      }
      const payload = await buildTradeQuery(tradeItem, weights);
      const searchId = await createTradeSearch(selectedLeague, payload);
      window.open(getTradeResultUrl(selectedLeague, searchId), '_blank');
    } catch (e) { console.error("Trade search failed", e); setError(`Trade search failed: ${e.message}`); }
    finally { setSearchingItems(prev => ({ ...prev, [itemId]: false })); }
  }

  // --- Render (tabbed layout) ---
  // Check if build has any timeless jewels
  const hasTimelessJewels = treeSpecs.some(spec =>
    Object.values(spec.jewelSockets || {}).some(item =>
      (item.raw || '').includes('Timeless Jewel') || (item.baseType || '').includes('Timeless')
    )
  );

  const tabs = [
    { id: 'items', label: 'Items' },
    { id: 'gems', label: 'Gems' },
    { id: 'stages', label: 'Stages' },
    { id: 'upgrade', label: 'Upgrade' },
    { id: 'audit', label: 'My Gear' },
    ...(hasTimelessJewels ? [{ id: 'timeless', label: 'Timeless' }] : []),
  ];

  return (
    <div className="min-h-screen bg-[#090a0c] text-slate-300 font-sans p-4 md:p-8">
      <div className="max-w-4xl mx-auto">
        <Header
          pobCode={pobCode} setPobCode={setPobCode} pobbinUrl={pobbinUrl}
          selectedLeague={selectedLeague} setSelectedLeague={setSelectedLeague} leagues={leagues}
          showSettings={showSettings} setShowSettings={setShowSettings}
          hasSession={hasSession} setHasSession={setHasSession} cfReady={cfReady} setCfReady={setCfReady}
          sessionInput={sessionInput} setSessionInput={setSessionInput}
          accountName={accountName} setAccountName={setAccountName}
          loginPending={loginPending} setLoginPending={setLoginPending}
          compareChars={compareChars} setCompareChars={setCompareChars}
          compareChar={compareChar} setCompareChar={setCompareChar}
          pobStatus={pobStatus} buildClass={buildClass} feedbackId={feedbackId}
          isProcessing={isProcessing} processPoB={processPoB}
          saveSession={saveSession} loadCompareChars={loadCompareChars} createPobbin={createPobbin}
        />

        {error && (
          <div className="mb-4 bg-red-900/30 border border-red-800 rounded-xl p-4 flex items-start gap-3">
            <AlertTriangle size={16} className="text-red-400 mt-0.5 shrink-0" />
            <p className="text-xs text-red-300">{error}</p>
            <button onClick={() => setError(null)} className="ml-auto text-red-400 hover:text-red-200 cursor-pointer">&times;</button>
          </div>
        )}

        {recentBuilds.length > 0 && (
          <div className="mb-8 flex flex-wrap gap-2">
            {recentBuilds.map((b, i) => (
              <button key={i} onClick={() => { setPobCode(b.pobCode); setPobbinUrl(b.pobbinUrl || ''); processPoB(b.pobCode); }}
                className="bg-[#1a1c24] border border-slate-800 hover:border-blue-500/50 px-4 py-3 rounded-xl flex items-center gap-3 transition-all group cursor-pointer"
              >
                <Clock size={12} className="text-blue-500" />
                <span className="text-xs font-black text-white group-hover:text-blue-400 transition-colors">{b.skillName}</span>
              </button>
            ))}
          </div>
        )}

        {/* Build info + tab bar */}
        {buildClass && (
          <div className="mb-6 bg-[#12141c] border border-slate-800 rounded-2xl p-4 shadow-lg">
            <div className="flex items-center justify-between mb-3">
              <div className="flex items-center gap-3">
                <span className="text-sm font-black text-white">{buildClass.ascName || buildClass.className}</span>
                {buildClass.ascName && <span className="text-[10px] text-slate-500">({buildClass.className})</span>}
              </div>
              <div className="flex items-center gap-2">
                {Object.keys(itemWeights).length > 0 && (
                  <span className="text-[8px] text-emerald-400/60 font-bold">{Object.keys(itemWeights).length} weighted</span>
                )}
                <div className={`flex items-center gap-1 px-2 py-1 rounded text-[8px] font-bold ${pobStatus?.running ? 'text-emerald-400 bg-emerald-900/20' : 'text-slate-600 bg-slate-800/50'}`}>
                  <Activity size={8} />
                  {pobStatus?.running ? 'PoB' : 'PoB off'}
                </div>
              </div>
            </div>
            {/* Character selector for compare (stays near build info) */}
            {compareChars.length > 0 && (
              <div className="flex items-center gap-2 mt-2">
                <select value={compareChar}
                  onChange={e => { setCompareChar(e.target.value); try { localStorage.setItem('pob-trade-char', e.target.value); } catch {} }}
                  className="bg-[#0a0b0e] border border-slate-700 rounded-lg px-2 py-1.5 text-[9px] font-bold text-slate-300 outline-none focus:border-yellow-600/50 max-w-[250px]"
                >
                  <option value="">Compare character...</option>
                  {compareChars.map(c => <option key={c.name} value={c.name}>{c.name} (Lv{c.level})</option>)}
                </select>
              </div>
            )}
          </div>
        )}

        {treeSpecs.length > 0 && <PassiveTree specs={treeSpecs} classId={buildClass?.classId} />}

        {/* Tab bar (below tree) */}
        {buildClass && (
          <div className="flex items-center gap-2 mb-4 mt-4 overflow-x-auto pb-1 -mx-1 px-1">
            <div className="flex rounded-lg overflow-hidden border border-slate-700 shrink-0">
              {tabs.map(t => (
                <button key={t.id}
                  onClick={() => {
                    setActiveTab(t.id);
                    if (t.id === 'audit' && Object.keys(compareItems).length === 0 && !compareLoading && compareChar) {
                      runComparison(compareChar);
                    }
                  }}
                  className={`px-4 py-2.5 min-h-[44px] text-[10px] font-black uppercase cursor-pointer transition-all whitespace-nowrap ${
                    activeTab === t.id ? 'bg-blue-600/20 text-blue-400' : 'bg-transparent text-slate-500 hover:text-slate-300'
                  }`}
                >{t.label}</button>
              ))}
            </div>
            {Object.keys(groupedItems).length > 0 && (
              <button onClick={calcAllWeights} disabled={Object.values(calcingWeights).some(Boolean)}
                className="border border-emerald-800/40 hover:border-emerald-600/50 rounded-lg px-3 py-2 text-[10px] font-black text-emerald-400 hover:text-emerald-300 transition-all cursor-pointer disabled:opacity-50 flex items-center gap-1.5"
              >
                {Object.values(calcingWeights).some(Boolean) ? <><Loader2 className="animate-spin" size={10} /> Calculating</> : <><Activity size={10} /> Weights</>}
              </button>
            )}
          </div>
        )}

        {/* Tab content */}
        {activeTab === 'gems' && (
          <GemsTab
            gemSetups={gemSetups} selectedSetupIdx={selectedSetupIdx}
            setSelectedSetupIdx={setSelectedSetupIdx} slotGems={slotGems}
            setSlotGems={setSlotGems} selectedLeague={selectedLeague}
          />
        )}

        {activeTab === 'stages' && buildClass && (
          <StagesTab
            groupedItems={groupedItems} compareItems={compareItems}
            selectedLeague={selectedLeague} hasSession={hasSession}
            openTrade={openTrade} searchingItems={searchingItems}
            itemWeights={itemWeights} setShowSettings={setShowSettings}
            setError={setError}
          />
        )}

        {activeTab === 'upgrade' && treeSpecs.length >= 2 && (
          <UpgradeTab treeSpecs={treeSpecs} pobCode={pobCode} />
        )}

        {activeTab === 'audit' && buildClass && (
          <GearAudit
            groupedItems={groupedItems} compareItems={compareItems}
            compareResults={compareResults} compareLoading={compareLoading}
            compareProgress={compareProgress} compareChar={compareChar}
            setCompareChar={setCompareChar}
            compareChars={compareChars} runComparison={runComparison}
            setShowSettings={setShowSettings} setError={setError}
            hasSession={hasSession} openTrade={openTrade}
            searchingItems={searchingItems} itemWeights={itemWeights}
            selectedLeague={selectedLeague}
          />
        )}

        {activeTab === 'timeless' && (
          <TimelessSearch
            specs={treeSpecs}
            treeData={treeData}
            selectedLeague={selectedLeague}
            pobCode={pobCode}
          />
        )}

        {activeTab === 'items' && activeCategory && (
          <ItemsTab
            groupedItems={groupedItems} activeCategory={activeCategory}
            setActiveCategory={setActiveCategory} collapsedSubGroups={collapsedSubGroups}
            setCollapsedSubGroups={setCollapsedSubGroups} excludedMods={excludedMods}
            setExcludedMods={setExcludedMods} itemWeights={itemWeights}
            calcingWeights={calcingWeights} searchingItems={searchingItems}
            feedbackId={feedbackId} debugItem={debugItem} setDebugItem={setDebugItem}
            selectedLeague={selectedLeague} hasSession={hasSession}
            openTrade={openTrade} copyToClipboard={copyToClipboard}
            calcAllWeights={calcAllWeights} setShowSettings={setShowSettings}
            setError={setError} leagueStartOpen={leagueStartOpen}
            setLeagueStartOpen={setLeagueStartOpen}
          />
        )}
      </div>
    </div>
  );
}
