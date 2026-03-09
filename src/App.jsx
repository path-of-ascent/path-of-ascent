import { useState, useEffect } from 'react';
import pako from 'pako';
import {
  Zap, ExternalLink, Copy, Check, Search, Loader2,
  ChevronDown, ChevronUp, Shield, Gem, FlaskConical,
  Diamond, Clock, LinkIcon, AlertTriangle, Settings
} from 'lucide-react';
import { createTradeSearch, getTradeResultUrl, buildTradeQuery, openGemTrade } from './tradeApi';
import { getGemSource } from './gemVendors';
import PassiveTree, { decodeTreeUrl } from './PassiveTree';


const CLASS_NAMES = ['Scion', 'Marauder', 'Ranger', 'Witch', 'Duelist', 'Templar', 'Shadow'];
const ASCENDANCY_NAMES = {
  0: ['Ascendant'],                              // Scion
  1: ['Juggernaut', 'Berserker', 'Chieftain'],   // Marauder
  2: ['Deadeye', 'Raider', 'Pathfinder'],         // Ranger
  3: ['Elementalist', 'Necromancer', 'Occultist'], // Witch
  4: ['Slayer', 'Gladiator', 'Champion'],         // Duelist
  5: ['Inquisitor', 'Hierophant', 'Guardian'],   // Templar
  6: ['Assassin', 'Saboteur', 'Trickster'],       // Shadow
};

function getBuildInfo(xmlDoc) {
  try {
    const spec = xmlDoc.getElementsByTagName("Spec")[0];
    const classId = parseInt(spec?.getAttribute("classId") || "0");
    const ascId = parseInt(spec?.getAttribute("ascendClassId") || "0");
    const className = CLASS_NAMES[classId] || 'Unknown';
    const ascName = ASCENDANCY_NAMES[classId]?.[ascId] || null;
    return { className, ascName, classId };
  } catch { return { className: 'Unknown', ascName: null, classId: 0 }; }
}

function getMainSkill(xmlDoc) {
  try {
    const skillsNode = xmlDoc.getElementsByTagName("Skills")[0];
    const activeSetId = skillsNode?.getAttribute("activeSkillSet") || "1";
    const skillSets = Array.from(xmlDoc.getElementsByTagName("SkillSet"));
    const activeSet = skillSets.find(s => s.getAttribute("id") === activeSetId) || skillSets[0];
    const skills = Array.from(activeSet?.getElementsByTagName("Skill") || []);
    const mainSkill = skills.find(s => s.getAttribute("mainSkill") === "true") || skills[0];
    const gems = Array.from(mainSkill?.getElementsByTagName("Gem") || []);
    const mainGem = gems.find(g => !g.getAttribute("nameSpec")?.toLowerCase().includes("support")) || gems[0];
    return mainGem?.getAttribute("nameSpec") || "Custom Build";
  } catch { return "Custom Build"; }
}

// Gem color by primary attribute requirement (Str=red, Dex=green, Int=blue)
const GEM_COLORS = {};
// Red (Strength) gems
['Molten Strike','Ground Slam','Heavy Strike','Cleave','Leap Slam','Shield Charge','Infernal Blow','Dominating Blow','Glacial Hammer','Sunder','Earthquake','Tectonic Slam','Consecrated Path','Earthshatter','Boneshatter','Perforate','Chain Hook','Bladestorm','Lacerate','Double Strike','Dual Strike','Vigilant Strike','Shield Crush','Cyclone','Ancestral Cry','Enduring Cry','Intimidating Cry','Seismic Cry','Infernal Cry','Rallying Cry','Battlemage\'s Cry','General\'s Cry','Vengeful Cry','Anger','Determination','Pride','Vitality','Punishment','Vulnerability','Warlord\'s Mark','Herald of Purity','Herald of Ash','War Banner','Defiance Banner','Flesh and Stone','Blood and Sand','Molten Shell','Steelskin','Immortal Call','Endurance Charge on Melee Stun Support','Melee Physical Damage Support','Ruthless Support','Chance to Bleed Support','Maim Support','Brutality Support','Rage Support','Pulverise Support','Bloodlust Support','Damage on Full Life Support','Iron Will Support','Iron Grip Support','Knockback Support','Life Gain on Hit Support','Lifetap Support','Stun Support','Shockwave Support','Close Combat Support','Impale Support','Volatility Support','Multistrike Support','Flamewood Support','Added Fire Damage Support','Combustion Support','Infused Channelling Support','Elemental Proliferation Support','Ancestral Call Support','Momentum Support','Raise Zombie','Summon Raging Spirit','Absolution','Animate Guardian','Holy Flame Totem','Searing Bond','Righteous Fire','Purifying Flame','Wave of Conviction','Divine Ire','Smite','Holy Sweep','Crushing Fist','Corrupting Fever','Petrified Blood','Autoexertion','Rejuvenation Totem','Summon Stone Golem','Summon Flame Golem','Devouring Totem','Decoy Totem'].forEach(n => GEM_COLORS[n] = 'red');
// Green (Dexterity) gems
['Burning Arrow','Split Arrow','Lightning Arrow','Ice Shot','Galvanic Arrow','Caustic Arrow','Tornado Shot','Rain of Arrows','Blast Rain','Scourge Arrow','Toxic Rain','Barrage','Elemental Hit','Spectral Throw','Spectral Helix','Frost Blades','Lightning Strike','Viper Strike','Cobra Lash','Venom Gyre','Pestilent Strike','Flicker Strike','Reave','Lacerate','Lancing Steel','Shattering Steel','Splitting Steel','Static Strike','Whirling Blades','Dash','Phase Run','Withering Step','Blink Arrow','Mirror Arrow','Ensnaring Arrow','Frenzy','Puncture','Blood Rage','Blade Flurry','Blade Trap','Grace','Haste','Dread Banner','Poacher\'s Mark','Assassin\'s Mark','Sniper\'s Mark','Herald of Agony','Herald of Ice','Pierce Support','Chain Support','Fork Support','Mirage Archer Support','Arrow Nova Support','Ballista Totem Support','Manaforged Arrows Support','Point Blank Support','Vicious Projectiles Support','Additional Accuracy Support','Blind Support','Faster Attacks Support','Added Cold Damage Support','Nightblade Support','Chance to Poison Support','Deadly Ailments Support','Trap Support','Multiple Traps Support','Cluster Trap Support','Trap and Mine Damage Support','Swift Assembly Support','Siege Ballista','Shrapnel Ballista','Artillery Ballista','Charged Dash','Kinetic Bolt','Bear Trap','Poisonous Concoction','Spectral Shield Throw','Rage Vortex','Storm Rain','Blade Blast','Smoke Mine','Summon Ice Golem'].forEach(n => GEM_COLORS[n] = 'green');
// Blue (Intelligence) gems
['Fireball','Freezing Pulse','Arc','Spark','Ice Nova','Ice Spear','Ball Lightning','Storm Call','Glacial Cascade','Shock Nova','Firestorm','Flameblast','Incinerate','Scorching Ray','Storm Burst','Lightning Tendrils','Blazing Salvo','Rolling Magma','Eye of Winter','Winter Orb','Divine Retribution','Creeping Frost','Frostbolt','Frostbite','Flammability','Conductivity','Elemental Weakness','Enfeeble','Despair','Temporal Chains','Discipline','Clarity','Malevolence','Hatred','Wrath','Zealotry','Purity of Elements','Purity of Fire','Purity of Ice','Purity of Lightning','Arctic Armour','Arcane Cloak','Tempest Shield','Flame Dash','Lightning Warp','Frostblink','Bodyswap','Frost Bomb','Frost Wall','Orb of Storms','Cold Snap','Detonate Dead','Volatile Dead','Dark Pact','Forbidden Rite','Essence Drain','Contagion','Blight','Soulrend','Bane','Hexblast','Blade Vortex','Bladefall','Ethereal Knives','Kinetic Blast','Power Siphon','Kinetic Fusillade','Kinetic Rain','Stormblast Mine','Icicle Mine','Pyroclast Mine','Lightning Trap','Lightning Spire Trap','Fire Trap','Flamethrower Trap','Ice Trap','Seismic Trap','Explosive Trap','Siphoning Trap','Summon Skeletons','Raise Spectre','Animate Weapon','Summon Carrion Golem','Summon Chaos Golem','Summon Lightning Golem','Summon Holy Relic','Bone Offering','Flesh Offering','Spirit Offering','Desecrate','Unearth','Spellslinger','Energy Blade','Armageddon Brand','Storm Brand','Penance Brand','Wintertide Brand','Brand Recall','Galvanic Field','Stormbind','Flame Wall','Flame Surge','Manabond','Exsanguinate','Reap','Conflagration','Voltaxic Burst','Wall of Force','Discharge','Portal','Summon Skitterbots','Summon Phantasm Support','Spell Echo Support','Spell Cascade Support','Faster Casting Support','Controlled Destruction Support','Concentrated Effect Support','Elemental Focus Support','Increased Critical Strikes Support','Increased Critical Damage Support','Power Charge On Critical Support','Added Lightning Damage Support','Hypothermia Support','Ice Bite Support','Innervate Support','Energy Leech Support','Inspiration Support','Unleash Support','Intensify Support','Hextouch Support','Blasphemy Support','Generosity Support','Cast when Damage Taken Support','Cast on Critical Strike Support','Blastchain Mine Support','Locus Mine Support','Multiple Projectiles Support','Greater Multiple Projectiles Support','Volley Support','Spell Totem Support','Minion Damage Support','Minion Life Support','Minion Speed Support','Feeding Frenzy Support','Predator Support','Fresh Meat Support','Living Lightning Support','Summon Phantasm Support','Efficacy Support','Void Manipulation Support','Cruelty Support','Unbound Ailments Support','Cold to Fire Support','Physical to Lightning Support','Elemental Damage with Attacks Support','Trinity Support','Overcharge Support','Sacred Wisps Support','Kinetic Instability Support','Infernal Legion Support','Added Chaos Damage Support','Devour Support','Sadism Support','Arcane Surge Support','Prismatic Burst Support','Wither','Empower Support','Enlighten Support','Enhance Support','Alchemist\'s Mark','Shockwave Totem','Somatic Shell','Plague Bearer','Conversion Trap','Glacial Shield Swipe','Swordstorm','Eviscerate','Automation','Melee Splash Support','Culling Strike Support'].forEach(n => GEM_COLORS[n] = 'blue');

function getGemColor(name) {
  const clean = name.replace(' Support', '');
  return GEM_COLORS[name] || GEM_COLORS[clean] || 'blue';
}

function parseGemSetups(xmlDoc) {
  const skillsNode = xmlDoc.getElementsByTagName("Skills")[0];
  if (!skillsNode) return [];

  const skillSets = Array.from(xmlDoc.getElementsByTagName("SkillSet"));

  function parseSkillSet(node, title) {
    const skills = Array.from(node.getElementsByTagName("Skill"));
    const groups = [];
    for (const skill of skills) {
      if (skill.getAttribute("enabled") === "false") continue;
      const slot = skill.getAttribute("slot") || "Unslotted";
      const isMain = skill.getAttribute("mainSkill") === "true";
      const gems = Array.from(skill.getElementsByTagName("Gem")).map(g => ({
        name: g.getAttribute("nameSpec") || "Unknown",
        level: parseInt(g.getAttribute("level") || "1"),
        quality: parseInt(g.getAttribute("quality") || "0"),
        isSupport: (g.getAttribute("gemId") || '').includes("SupportGem") || (g.getAttribute("skillId") || '').toLowerCase().startsWith("support"),
        skillId: g.getAttribute("skillId") || "",
      })).filter(g => g.name && g.name !== "Unknown");
      if (gems.length === 0) continue;
      groups.push({ slot, isMain, gems });
    }

    // Determine if this is a leveling section based on gem levels
    const allGemLevels = groups.flatMap(g => g.gems.map(gem => gem.level));
    const maxGemLevel = Math.max(0, ...allGemLevels);
    const avgGemLevel = allGemLevels.length ? allGemLevels.reduce((a, b) => a + b, 0) / allGemLevels.length : 0;
    const isLeveling = maxGemLevel <= 20 && avgGemLevel < 15;
    const isEarlyGame = maxGemLevel <= 10 || /level|early|act [1-5]|leveling/i.test(title);

    return { title, groups, isLeveling, isEarlyGame, maxGemLevel };
  }

  if (skillSets.length > 0) {
    return skillSets.map(ss => parseSkillSet(ss, ss.getAttribute("title") || "Default"));
  }
  // No SkillSets — parse Skill nodes directly under Skills
  return [parseSkillSet(skillsNode, "Default")];
}

function getItemCategory(item) {
  const raw = item.raw.toLowerCase();
  const base = item.baseType.toLowerCase();
  if (item.rarity === 'Gem' || raw.includes('level: #')) return 'Skill Gems';
  if (base.includes('flask') || raw.includes('flask')) return 'Flasks';
  if (base.includes('jewel') || raw.includes('jewel') || base.includes('cluster')) return 'Jewels';
  return 'Equipment';
}

function loadHistory() {
  try {
    return JSON.parse(localStorage.getItem('pob-trade-history') || '[]');
  } catch { return []; }
}

function saveHistory(builds) {
  localStorage.setItem('pob-trade-history', JSON.stringify(builds.slice(0, 5)));
}

export default function App() {
  const [recentBuilds, setRecentBuilds] = useState(() => loadHistory());
  const [pobCode, setPobCode] = useState('');
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
  const [slotGems, setSlotGems] = useState({});
  const [showSettings, setShowSettings] = useState(false);
  const [hasSession, setHasSession] = useState(false);
  const [cfReady, setCfReady] = useState(false);
  const [sessionInput, setSessionInput] = useState('');

  useEffect(() => {
    (async () => {
      try {
        const [leagueRes, configRes] = await Promise.allSettled([
          fetch('https://api.pathofexile.com/leagues?type=main'),
          fetch('/api/config'),
        ]);
        if (leagueRes.status === 'fulfilled' && leagueRes.value.ok) {
          const data = await leagueRes.value.json();
          const permanent = ['Standard', 'Hardcore', 'Ruthless', 'Hardcore Ruthless'];
          const active = data.filter(l => !l.id.includes('SSF') && !l.id.includes('Solo')).map(l => l.id);
          setLeagues(active);
          const saved = localStorage.getItem('pob-trade-league');
          if (saved && active.includes(saved)) {
            setSelectedLeague(saved);
          } else {
            const newest = active.find(l => !permanent.includes(l) && !l.includes('Ruthless')) || active[0];
            setSelectedLeague(newest);
          }
        }
        if (configRes.status === 'fulfilled' && configRes.value.ok) {
          const cfg = await configRes.value.json();
          setHasSession(cfg.hasSession);
          setCfReady(cfg.cfReady);
          if (!cfg.hasSession) setShowSettings(true);
        }
      } catch { /* use defaults */ }
    })();
  }, []);

  async function saveSession() {
    if (!sessionInput.trim()) return;
    try {
      const res = await fetch('/api/config', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ poesessid: sessionInput.trim() }),
      });
      if (res.ok) {
        setHasSession(true);
        setShowSettings(false);
        setSessionInput('');
      }
    } catch (e) {
      setError('Failed to save session: ' + e.message);
    }
  }

  function copyToClipboard(text, id) {
    navigator.clipboard.writeText(text).then(() => {
      setFeedbackId(id);
      setTimeout(() => setFeedbackId(null), 2000);
    }).catch(console.error);
  }

  function processPoB(codeOverride) {
    const target = codeOverride || pobCode;
    if (!target) return;
    setIsProcessing(true);
    setError(null);
    try {
      const base64 = target.trim().replace(/-/g, '+').replace(/_/g, '/');
      const bytes = new Uint8Array(atob(base64).split('').map(c => c.charCodeAt(0)));
      const inflated = pako.inflate(bytes, { to: 'string' });
      const parser = new DOMParser();
      const xmlDoc = parser.parseFromString(inflated, "text/xml");

      const itemsMap = {};
      Array.from(xmlDoc.getElementsByTagName("Item")).forEach(node => {
        const id = node.getAttribute('id');
        const raw = node.textContent.trim();
        const lines = raw.split('\n').map(l => l.trim()).filter(l => l.length > 0);
        const rarityRaw = (lines[0].match(/Rarity: (\w+)/i) || [null, "Normal"])[1];
        const rarity = rarityRaw.charAt(0).toUpperCase() + rarityRaw.slice(1).toLowerCase();

        // PoB item format: Rarity line, then name lines, then metadata.
        // Unique/Rare: line1 = item name, line2 = base type
        // Normal/Magic: line1 = base type (no separate name)
        // Skip metadata lines like "Unique ID:", "Item Level:", etc.
        const isMetadata = (l) => /^(Unique ID|Item Level|Quality|Sockets|LevelReq|Implicits|Variant|Selected Variant|Has Alt Variant|Has Alt Variant Two|League|Source|Crafted|Prefix|Suffix|Talisman Tier|Elder Item|Shaper Item|Fractured Item|Synthesised Item|Radius|Limited to|Cluster Jewel):/.test(l) || /^[0-9a-f]{32,}$/i.test(l);

        let name, baseType;
        if (['Unique', 'Rare'].includes(rarity)) {
          name = lines[1] || "Unknown Item";
          // Find base type: first non-metadata line after name
          baseType = '';
          for (let i = 2; i < Math.min(lines.length, 6); i++) {
            if (!isMetadata(lines[i]) && !lines[i].startsWith('---')) {
              baseType = lines[i];
              break;
            }
          }
        } else {
          // Normal/Magic: line1 is the base type
          name = lines[1] || "Unknown Item";
          baseType = lines[1] || "";
        }
        // Extract defence/weapon properties
        const properties = {};
        const propPatterns = {
          'Armour': /^Armour:\s*(\d+)/,
          'Evasion': /^Evasion Rating:\s*(\d+)|^Evasion:\s*(\d+)/,
          'Energy Shield': /^Energy Shield:\s*(\d+)/,
          'Physical Damage': /^Physical Damage:\s*(\d+)-(\d+)/,
          'Elemental Damage': /^Elemental Damage:\s*(.+)/,
          'Critical Strike Chance': /^Critical Strike Chance:\s*([\d.]+)/,
          'Attacks per Second': /^Attacks per Second:\s*([\d.]+)/,
          'Weapon Range': /^Weapon Range:\s*(\d+)/,
        };
        for (const line of lines) {
          for (const [key, regex] of Object.entries(propPatterns)) {
            const m = line.match(regex);
            if (m) {
              if (key === 'Physical Damage') properties[key] = `${m[1]}-${m[2]}`;
              else if (key === 'Elemental Damage') properties[key] = m[1];
              else properties[key] = m[1] || m[2];
            }
          }
        }

        const stats = [];
        lines.forEach((line, idx) => {
          if (idx < 3 || line.includes('{') || line.startsWith('---') || line.length < 3) return;
          if (isMetadata(line)) return;
          if (line.includes(':') && !['Resistance', 'Life', 'Mana', 'Energy Shield', 'Strength', 'Dexterity', 'Intelligence'].some(s => line.includes(s))) return;
          stats.push(line);
        });
        itemsMap[id] = { id, rarity, name, baseType, stats, properties, raw };
      });

      const groups = {};
      Array.from(xmlDoc.getElementsByTagName("ItemSet")).forEach(setNode => {
        const title = setNode.getAttribute('title') || "Default";
        const sub = { Equipment: [], 'Skill Gems': [], Flasks: [], Jewels: [] };
        Array.from(setNode.getElementsByTagName("Slot")).forEach(slot => {
          const item = itemsMap[slot.getAttribute('itemId')];
          if (item) {
            const cat = getItemCategory(item);
            const slotName = slot.getAttribute('name') || '';
            if (!sub[cat].find(i => i.id === item.id)) sub[cat].push({ ...item, slotName });
          }
        });
        groups[title] = sub;
      });

      // If no ItemSets, grab items from Slots directly
      if (Object.keys(groups).length === 0) {
        const sub = { Equipment: [], 'Skill Gems': [], Flasks: [], Jewels: [] };
        Array.from(xmlDoc.getElementsByTagName("Slot")).forEach(slot => {
          const item = itemsMap[slot.getAttribute('itemId')];
          if (item) {
            const cat = getItemCategory(item);
            const slotName = slot.getAttribute('name') || '';
            if (!sub[cat].find(i => i.id === item.id)) sub[cat].push({ ...item, slotName });
          }
        });
        groups["Default"] = sub;
      }

      setGroupedItems(groups);
      const keys = Object.keys(groups);
      const savedCat = localStorage.getItem('pob-trade-itemset');
      setActiveCategory(savedCat && keys.includes(savedCat) ? savedCat : keys[0] || '');

      // Parse class and gem setups
      const buildInfo = getBuildInfo(xmlDoc);
      setBuildClass(buildInfo);
      const setups = parseGemSetups(xmlDoc);
      setGemSetups(setups);

      // Enrich all gem setups with source/color info
      const activeSkillSetId = xmlDoc.getElementsByTagName("Skills")[0]?.getAttribute("activeSkillSet") || "1";
      const skillSetsXml = Array.from(xmlDoc.getElementsByTagName("SkillSet"));
      const enrichedSetups = setups.map((setup, i) => {
        const isActive = skillSetsXml[i]?.getAttribute("id") === activeSkillSetId;
        const groups = setup.groups.map(group => {
          const gems = group.gems.map(g => {
            const src = getGemSource(g.name, buildInfo.className, setup.isEarlyGame);
            return { ...g, source: src.text, sourceDetail: src.detail, color: getGemColor(g.name) };
          });
          return { ...group, gems };
        });
        return { ...setup, groups, isActive };
      });
      setGemSetups(enrichedSetups);

      // Default to saved or active skill set
      const savedGemIdx = parseInt(localStorage.getItem('pob-trade-gemsetup') || '-1');
      const activeIdx = enrichedSetups.findIndex(s => s.isActive);
      const chosenIdx = savedGemIdx >= 0 && savedGemIdx < enrichedSetups.length ? savedGemIdx : (activeIdx >= 0 ? activeIdx : 0);
      setSelectedSetupIdx(chosenIdx);
      setSlotGems(enrichedSetups[chosenIdx]?.groups || []);

      // Parse passive tree specs
      const parsedTreeSpecs = [];
      const specElements = Array.from(xmlDoc.getElementsByTagName("Spec"));
      for (const specEl of specElements) {
        const urlEl = specEl.getElementsByTagName("URL")[0];
        const urlText = urlEl?.textContent?.trim();
        if (!urlText) continue;
        const decoded = decodeTreeUrl(urlText);
        if (!decoded || decoded.nodes.size === 0) continue;
        const title = specEl.getAttribute("title") || `Tree ${parsedTreeSpecs.length + 1}`;
        parsedTreeSpecs.push({ title, nodes: decoded.nodes });
      }
      setTreeSpecs(parsedTreeSpecs);

      if (!codeOverride) {
        const skillName = getMainSkill(xmlDoc);
        const updated = [
          { skillName, pobCode: target, timestamp: Date.now() },
          ...recentBuilds.filter(b => b.pobCode !== target)
        ].slice(0, 5);
        setRecentBuilds(updated);
        saveHistory(updated);
      }
    } catch (e) {
      console.error("Process error", e);
      setError("Failed to decode PoB string. Make sure you're pasting a valid export code.");
    } finally {
      setIsProcessing(false);
    }
  }

  async function openTrade(item, itemId) {
    if (!hasSession) {
      setShowSettings(true);
      setError("Set your POESESSID first — required for trade searches.");
      return;
    }
    setSearchingItems(prev => ({ ...prev, [itemId]: true }));
    try {
      const payload = await buildTradeQuery(item);
      const searchId = await createTradeSearch(selectedLeague, payload);
      const url = getTradeResultUrl(selectedLeague, searchId);
      window.open(url, '_blank');
    } catch (e) {
      console.error("Trade search failed", e);
      setError(`Trade search failed: ${e.message}`);
    } finally {
      setSearchingItems(prev => ({ ...prev, [itemId]: false }));
    }
  }

  const activeSubGroups = groupedItems[activeCategory] || {};

  const categoryConfig = [
    { label: 'Equipment', icon: <Shield size={16} /> },
    { label: 'Skill Gems', icon: <Gem size={16} /> },
    { label: 'Flasks', icon: <FlaskConical size={16} /> },
    { label: 'Jewels', icon: <Diamond size={16} /> },
  ];

  return (
    <div className="min-h-screen bg-[#090a0c] text-slate-300 font-sans p-4 md:p-8">
      <div className="max-w-4xl mx-auto">
        <header className="flex justify-between items-center mb-8">
          <div className="flex items-center gap-3">
            <div className="p-2 bg-blue-600 rounded-xl shadow-lg shadow-blue-900/40">
              <Zap className="text-white fill-white" size={20} />
            </div>
            <h1 className="text-2xl font-black text-white italic uppercase tracking-tighter">Path of Ascent</h1>
          </div>
          <div className="flex items-center gap-2">
            <select
              value={selectedLeague}
              onChange={e => { setSelectedLeague(e.target.value); try { localStorage.setItem('pob-trade-league', e.target.value); } catch {} }}
              className="bg-[#12141c] border border-slate-800 rounded-lg px-3 py-2 text-xs font-black text-blue-400 outline-none"
            >
              {leagues.map(l => <option key={l} value={l}>{l}</option>)}
            </select>
            <button
              onClick={() => setShowSettings(s => !s)}
              className={`p-2 rounded-lg border transition-colors cursor-pointer ${hasSession && cfReady ? 'bg-[#12141c] border-slate-800 text-slate-400 hover:text-white' : 'bg-red-900/30 border-red-800 text-red-400 hover:text-red-200'}`}
            >
              <Settings size={16} />
            </button>
          </div>
        </header>

        {showSettings && (
          <div className="bg-[#12141c] rounded-2xl border border-slate-800 p-5 mb-4 shadow-2xl">
            <div className="flex items-center justify-between mb-3">
              <span className="text-xs font-black text-white uppercase tracking-widest">Session</span>
              <div className="flex gap-2">
                {hasSession && <span className="text-[10px] font-bold text-green-400 bg-green-900/30 px-2 py-0.5 rounded-md">POESESSID</span>}
                <span className={`text-[10px] font-bold px-2 py-0.5 rounded-md ${cfReady ? 'text-green-400 bg-green-900/30' : 'text-yellow-400 bg-yellow-900/30'}`}>
                  {cfReady ? 'CF Ready' : 'CF Loading...'}
                </span>
              </div>
            </div>
            <p className="text-[10px] text-slate-500 mb-3">
              Your POESESSID from pathofexile.com. On mobile: Settings &gt; Site settings &gt; All sites &gt; pathofexile.com &gt; Cookies. Cloudflare is handled automatically.
            </p>
            <div className="flex gap-2">
              <input
                type="password"
                value={sessionInput}
                onChange={e => setSessionInput(e.target.value)}
                placeholder={hasSession ? "Update POESESSID..." : "Paste POESESSID..."}
                className="flex-1 bg-[#0a0b0e] border border-slate-800 rounded-xl px-4 py-3 text-xs font-mono text-blue-300 outline-none focus:border-blue-500/50 transition-colors"
                onKeyDown={e => e.key === 'Enter' && saveSession()}
              />
              <button
                onClick={saveSession}
                disabled={!sessionInput.trim()}
                className="bg-blue-600 hover:bg-blue-700 px-5 py-3 rounded-xl text-xs font-black text-white transition-all cursor-pointer disabled:opacity-30"
              >
                SAVE
              </button>
            </div>
          </div>
        )}

        <div className="bg-[#12141c] rounded-3xl border border-slate-800 p-6 mb-4 shadow-2xl">
          <textarea
            value={pobCode}
            onChange={e => setPobCode(e.target.value)}
            placeholder="Paste PoB export string..."
            className="w-full h-20 bg-[#0a0b0e] border border-slate-800 rounded-2xl p-4 text-[10px] font-mono text-blue-300 outline-none mb-4 resize-none focus:border-blue-500/50 transition-colors"
          />
          <button
            onClick={() => processPoB()}
            disabled={isProcessing}
            className="w-full bg-blue-600 hover:bg-blue-700 py-4 rounded-2xl font-black text-white transition-all flex justify-center items-center gap-2 active:scale-95 shadow-xl cursor-pointer disabled:opacity-50"
          >
            {isProcessing ? <Loader2 className="animate-spin" size={20} /> : "GENERATE TRADE LINKS"}
          </button>
        </div>

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
              <button
                key={i}
                onClick={() => { setPobCode(b.pobCode); processPoB(b.pobCode); }}
                className="bg-[#1a1c24] border border-slate-800 hover:border-blue-500/50 px-4 py-3 rounded-xl flex items-center gap-3 transition-all group cursor-pointer"
              >
                <Clock size={12} className="text-blue-500" />
                <span className="text-xs font-black text-white group-hover:text-blue-400 transition-colors">{b.skillName}</span>
              </button>
            ))}
          </div>
        )}

        {buildClass && (
          <div className="mb-6 flex items-center gap-3">
            <div className="bg-[#12141c] border border-slate-800 rounded-xl px-4 py-3">
              <span className="text-[10px] font-black text-slate-500 uppercase tracking-widest mr-2">Class</span>
              <span className="text-sm font-black text-white">{buildClass.ascName || buildClass.className}</span>
              {buildClass.ascName && <span className="text-[10px] text-slate-500 ml-1">({buildClass.className})</span>}
            </div>
          </div>
        )}

        {treeSpecs.length > 0 && <PassiveTree specs={treeSpecs} />}

        {Array.isArray(slotGems) && slotGems.length > 0 && (
          <div className="bg-[#12141c] border border-slate-800 rounded-2xl overflow-hidden shadow-lg mb-6">
            <div className="px-5 py-3 border-b border-slate-800/50 flex items-center justify-between">
              <span className="text-xs font-black text-white uppercase tracking-widest">Gems</span>
              {gemSetups.length > 1 && (
                <select
                  value={selectedSetupIdx}
                  onChange={e => { const idx = parseInt(e.target.value); setSelectedSetupIdx(idx); setSlotGems(gemSetups[idx]?.groups || []); try { localStorage.setItem('pob-trade-gemsetup', idx.toString()); } catch {} }}
                  className="bg-[#0a0c12] border border-slate-700 rounded-lg px-2 py-1 text-[10px] font-bold text-slate-300 appearance-none outline-none"
                >
                  {gemSetups.map((s, i) => <option key={i} value={i}>{s.title}{s.isActive ? ' ★' : ''}</option>)}
                </select>
              )}
            </div>
            <div className="px-5 py-4 space-y-4">
              {(() => {
                // Compute diff: gems in current setup vs previous setup
                const prevSetup = selectedSetupIdx > 0 ? gemSetups[selectedSetupIdx - 1] : null;
                const prevGemNames = new Set();
                if (prevSetup) {
                  for (const g of prevSetup.groups) {
                    for (const gem of g.gems) prevGemNames.add(gem.name);
                  }
                }
                const curGemNames = new Set();
                for (const g of slotGems) {
                  for (const gem of g.gems) curGemNames.add(gem.name);
                }
                const removedGems = prevSetup ? [...prevGemNames].filter(n => !curGemNames.has(n)) : [];

                return <>
                  {slotGems.map((group, gi) => {
                    const actives = group.gems.filter(g => !g.isSupport);
                    const supports = group.gems.filter(g => g.isSupport);
                    const colorMap = { red: 'text-[#e8a4a4]', green: 'text-[#a4d8a4]', blue: 'text-[#a4b8d8]' };
                    const linkCount = group.gems.length;
                    const linkLabel = linkCount > 1 ? `${linkCount}L` : '';
                    const hasLinks = supports.length > 0;
                    const isNew = (name) => prevSetup && !prevGemNames.has(name);
                    return (
                      <div key={gi} className="border-b border-slate-800/30 pb-3 last:border-0 last:pb-0">
                        <div className="flex items-center gap-2 mb-1.5">
                          {group.slot && <span className="text-[9px] font-bold text-slate-500 uppercase tracking-wider">{group.slot}</span>}
                          {linkLabel && <span className={`text-[9px] font-black rounded px-1.5 py-0.5 ${hasLinks ? 'text-blue-400/70 bg-blue-400/10' : 'text-slate-500/70 bg-slate-800/50'}`}>{linkLabel}{!hasLinks && actives.length > 1 ? ' unlinked' : ''}</span>}
                        </div>
                        {/* Linked group: show gems in order with link line */}
                        {hasLinks ? (
                          <div className="flex items-start gap-1.5">
                            <div className="flex flex-col items-center pt-1" style={{width: '6px'}}>
                              {group.gems.map((_, i) => (
                                <div key={i} className="flex flex-col items-center">
                                  <div className={`w-1.5 h-1.5 rounded-full ${group.gems[i].isSupport ? 'bg-slate-600' : 'bg-blue-500'}`} />
                                  {i < group.gems.length - 1 && <div className="w-px h-3 bg-blue-500/30" />}
                                </div>
                              ))}
                            </div>
                            <div className="flex-1 space-y-0.5">
                              {group.gems.map((gem, si) => (
                                <div key={si} className="flex items-center justify-between">
                                  <div className="flex items-center gap-1">
                                    <span className={`${gem.isSupport ? 'text-[10px]' : 'text-[11px] font-black'} ${isNew(gem.name) ? 'text-green-400' : (colorMap[gem.color] || (gem.isSupport ? 'text-slate-400' : 'text-slate-200'))}`}>
                                      {isNew(gem.name) && <span className="text-[8px] mr-1">+</span>}
                                      {gem.isSupport ? gem.name.replace(' Support', '') : gem.name}
                                    </span>
                                    <span className="text-[7px] text-slate-500 ml-1">⚑</span>
                                    <button onClick={() => openGemTrade(selectedLeague, gem.name, gem.level, gem.quality || null)} className="text-[8px] text-purple-400 hover:text-purple-300 font-bold px-1 rounded bg-purple-400/10 hover:bg-purple-400/20" title={`Buy ${gem.name} L${gem.level}${gem.quality ? '/Q' + gem.quality : ''} (as in guide)`}>{gem.level}/{gem.quality || 0}</button>
                                    <button onClick={() => openGemTrade(selectedLeague, gem.name, 20)} className="text-[8px] text-emerald-400 hover:text-emerald-300 font-bold px-1 rounded bg-emerald-400/10 hover:bg-emerald-400/20" title={`Buy ${gem.name} level 20`}>L20</button>
                                    <button onClick={() => openGemTrade(selectedLeague, gem.name, 20, 20, { corrupted: 'any' })} className="text-[8px] text-blue-400 hover:text-blue-300 font-bold px-1 rounded bg-blue-400/10 hover:bg-blue-400/20 border border-red-500/50" title={`Buy ${gem.name} level 20 quality 20 (any corrupt)`}>20/20</button>
                                  </div>
                                  <span className={`text-[8px] font-bold ${gem.isSupport ? 'text-amber-400/40' : 'text-amber-400/60'}`}>{gem.source}</span>
                                </div>
                              ))}
                            </div>
                          </div>
                        ) : (
                          /* Unlinked: just list all gems */
                          actives.map((gem, si) => (
                            <div key={si} className="flex items-center justify-between">
                              <div className="flex items-center gap-1">
                                <span className={`text-[11px] font-black ${isNew(gem.name) ? 'text-green-400' : (colorMap[gem.color] || 'text-slate-200')}`}>
                                  {isNew(gem.name) && <span className="text-[8px] mr-1">+</span>}
                                  {gem.name}
                                </span>
                                <span className="text-[7px] text-slate-500 ml-1">⚑</span>
                                <button onClick={() => openGemTrade(selectedLeague, gem.name, gem.level, gem.quality || null)} className="text-[8px] text-purple-400 hover:text-purple-300 font-bold px-1 rounded bg-purple-400/10 hover:bg-purple-400/20" title={`Buy ${gem.name} L${gem.level}${gem.quality ? '/Q' + gem.quality : ''} (as in guide)`}>{gem.level}/{gem.quality || 0}</button>
                                <button onClick={() => openGemTrade(selectedLeague, gem.name, 20)} className="text-[8px] text-emerald-400 hover:text-emerald-300 font-bold ml-1 px-1 rounded bg-emerald-400/10 hover:bg-emerald-400/20" title={`Buy ${gem.name} level 20`}>L20</button>
                                <button onClick={() => openGemTrade(selectedLeague, gem.name, 20, 20, { corrupted: 'any' })} className="text-[8px] text-blue-400 hover:text-blue-300 font-bold px-1 rounded bg-blue-400/10 hover:bg-blue-400/20 border border-red-500/50" title={`Buy ${gem.name} level 20 quality 20 (any corrupt)`}>20/20</button>
                              </div>
                              <span className="text-[8px] text-amber-400/60 font-bold">{gem.source}</span>
                            </div>
                          ))
                        )}
                      </div>
                    );
                  })}
                  {removedGems.length > 0 && (
                    <div className="border-t border-slate-800/30 pt-3">
                      <span className="text-[9px] font-bold text-slate-600 uppercase tracking-wider mb-1 block">Removed</span>
                      {removedGems.map((name, i) => (
                        <div key={i} className="flex items-center pl-3">
                          <span className="text-[10px] text-red-400/70 line-through">
                            <span className="mr-1">-</span>{name.replace(' Support', '')}
                          </span>
                        </div>
                      ))}
                    </div>
                  )}
                </>;
              })()}
            </div>
          </div>
        )}

        {activeCategory && (
          <div className="space-y-6">
            <div className="space-y-2">
              <label className="text-[11px] font-black text-slate-500 uppercase tracking-widest ml-1">Item Set</label>
              <div className="relative">
                <select
                  value={activeCategory}
                  onChange={e => { setActiveCategory(e.target.value); try { localStorage.setItem('pob-trade-itemset', e.target.value); } catch {} }}
                  className="w-full bg-[#12141c] border-2 border-slate-800 rounded-2xl px-6 py-5 text-sm font-black text-white uppercase italic appearance-none focus:border-blue-600 outline-none shadow-2xl"
                >
                  {Object.keys(groupedItems).map(name => <option key={name} value={name}>{name}</option>)}
                </select>
                <ChevronDown size={24} className="absolute right-6 top-1/2 -translate-y-1/2 pointer-events-none text-blue-500" />
              </div>
            </div>

            <div className="space-y-4">
              {categoryConfig.map(({ label, icon }) => {
                const items = activeSubGroups[label] || [];
                if (items.length === 0) return null;
                const isCollapsed = collapsedSubGroups[label];
                return (
                  <div key={label} className="bg-[#12141c] border border-slate-800 rounded-2xl overflow-hidden shadow-lg">
                    <button
                      onClick={() => setCollapsedSubGroups(p => { const next = { ...p, [label]: !p[label] }; try { localStorage.setItem('pob-trade-tabs', JSON.stringify(next)); } catch {} return next; })}
                      className="w-full px-6 py-4 flex items-center justify-between hover:bg-[#1a1c24] transition-colors cursor-pointer"
                    >
                      <div className="flex items-center gap-3">
                        <div className="text-blue-500">{icon}</div>
                        <span className="text-xs font-black text-white uppercase tracking-widest">{label}</span>
                        <span className="text-[10px] font-bold text-slate-500 bg-slate-800 px-2 py-0.5 rounded-md">{items.length}</span>
                      </div>
                      {isCollapsed ? <ChevronDown size={18} /> : <ChevronUp size={18} />}
                    </button>
                    {!isCollapsed && (
                      <div className="p-4 grid grid-cols-1 md:grid-cols-2 gap-4 border-t border-slate-800/50 bg-[#0d0e12]">
                        {items.map((item, idx) => {
                          const itemId = `${label}-${idx}`;
                          const isSearching = searchingItems[itemId];
                          return (
                            <div key={idx} className="bg-[#1a1c24] border border-slate-800 rounded-2xl p-5 flex flex-col justify-between hover:border-blue-500/30 transition-all shadow-md">
                              <div>
                                <div className="flex justify-between items-start mb-3">
                                  <div className="flex flex-col">
                                    <span className={`text-[9px] font-black uppercase tracking-widest opacity-80 mb-0.5 ${item.rarity === 'Unique' ? 'text-[#af6025]' : 'text-yellow-200'}`}>
                                      {item.rarity} {item.baseType}
                                    </span>
                                    <h3 className={`font-black text-sm leading-tight tracking-tight ${item.rarity === 'Unique' ? 'text-[#af6025]' : 'text-yellow-200'}`}>
                                      {item.name}
                                    </h3>
                                  </div>
                                  <button
                                    onClick={() => copyToClipboard(item.raw, itemId)}
                                    className="p-2 bg-[#0a0b0e] rounded-xl text-slate-600 hover:text-white border border-slate-800 transition-colors cursor-pointer"
                                  >
                                    {feedbackId === itemId ? <Check size={14} className="text-green-500" /> : <Copy size={14} />}
                                  </button>
                                </div>
                                {item.properties && Object.keys(item.properties).length > 0 && (
                                  <div className="flex flex-wrap gap-x-3 gap-y-1 mb-2 pb-2 border-b border-slate-800/40">
                                    {item.properties['Armour'] && <span className="text-[9px] text-slate-400"><span className="text-slate-600">AR </span><span className="text-white font-bold">{item.properties['Armour']}</span></span>}
                                    {item.properties['Evasion'] && <span className="text-[9px] text-slate-400"><span className="text-slate-600">EV </span><span className="text-white font-bold">{item.properties['Evasion']}</span></span>}
                                    {item.properties['Energy Shield'] && <span className="text-[9px] text-slate-400"><span className="text-slate-600">ES </span><span className="text-white font-bold">{item.properties['Energy Shield']}</span></span>}
                                    {item.properties['Physical Damage'] && <span className="text-[9px] text-slate-400"><span className="text-slate-600">pDPS </span><span className="text-white font-bold">{item.properties['Physical Damage']}</span></span>}
                                    {item.properties['Elemental Damage'] && <span className="text-[9px] text-slate-400"><span className="text-slate-600">eDMG </span><span className="text-white font-bold">{item.properties['Elemental Damage']}</span></span>}
                                    {item.properties['Critical Strike Chance'] && <span className="text-[9px] text-slate-400"><span className="text-slate-600">Crit </span><span className="text-white font-bold">{item.properties['Critical Strike Chance']}%</span></span>}
                                    {item.properties['Attacks per Second'] && <span className="text-[9px] text-slate-400"><span className="text-slate-600">APS </span><span className="text-white font-bold">{item.properties['Attacks per Second']}</span></span>}
                                  </div>
                                )}
                                <div className="space-y-1.5 mb-3 min-h-[60px]">
                                  {item.stats.slice(0, 5).map((s, i) => (
                                    <div key={i} className="text-[10px] text-slate-400 flex gap-2">
                                      <span className="text-blue-500 font-bold opacity-30">/</span>
                                      <span className="truncate">{s}</span>
                                    </div>
                                  ))}
                                </div>
                              </div>
                              <button
                                onClick={() => openTrade(item, itemId)}
                                disabled={isSearching}
                                className="w-full bg-[#1c212d] hover:bg-blue-600 border border-slate-700 hover:border-blue-500 py-3 rounded-xl text-[11px] font-black text-slate-200 hover:text-white flex items-center justify-center gap-2 shadow-lg transition-all cursor-pointer disabled:opacity-50"
                              >
                                {isSearching ? (
                                  <><Loader2 className="animate-spin" size={14} /> SEARCHING...</>
                                ) : (
                                  <>OPEN TRADE <ExternalLink size={14} /></>
                                )}
                              </button>
                            </div>
                          );
                        })}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
