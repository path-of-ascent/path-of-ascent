import { useEffect, useRef, useState, useCallback, useMemo } from 'react';
import * as PIXI from 'pixi.js';
import { Viewport } from 'pixi-viewport';

import { loadTreeSprites, getNodeIconTexture, getFrameTexture } from './treeSprites';
import { parseClusterJewel, generateClusterNodes } from './clusterJewels';
import { parseTimelessJewel, getNodesInRadius, getTransforms } from './timelessJewels';

const TREE_DATA_URL = 'https://raw.githubusercontent.com/grindinggear/skilltree-export/master/data.json';

let cachedTreeData = null;
let cachedPositions = null;

export async function fetchTreeData() {
  if (cachedTreeData) return cachedTreeData;
  const res = await fetch(TREE_DATA_URL);
  if (!res.ok) throw new Error('Failed to fetch tree data');
  cachedTreeData = await res.json();
  return cachedTreeData;
}

export function computeAllPositions(treeData) {
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

// --- Spatial hash for O(1) hit detection ---
class SpatialHash {
  constructor(cellSize = 40) {
    this.cellSize = cellSize;
    this.cells = new Map();
  }

  clear() {
    this.cells.clear();
  }

  _key(x, y) {
    const cx = Math.floor(x / this.cellSize);
    const cy = Math.floor(y / this.cellSize);
    return `${cx},${cy}`;
  }

  insert(item) {
    // item: { id, x, y, r, node, ... }
    const minCx = Math.floor((item.x - item.r) / this.cellSize);
    const maxCx = Math.floor((item.x + item.r) / this.cellSize);
    const minCy = Math.floor((item.y - item.r) / this.cellSize);
    const maxCy = Math.floor((item.y + item.r) / this.cellSize);

    for (let cx = minCx; cx <= maxCx; cx++) {
      for (let cy = minCy; cy <= maxCy; cy++) {
        const key = `${cx},${cy}`;
        if (!this.cells.has(key)) this.cells.set(key, []);
        this.cells.get(key).push(item);
      }
    }
  }

  query(x, y) {
    const key = this._key(x, y);
    const candidates = this.cells.get(key) || [];
    let closest = null;
    let closestDist = Infinity;
    for (const item of candidates) {
      const dx = x - item.x;
      const dy = y - item.y;
      const dist = Math.sqrt(dx * dx + dy * dy);
      if (dist < item.r && dist < closestDist) {
        closest = item;
        closestDist = dist;
      }
    }
    return closest;
  }
}

// --- PIXI Tree Renderer ---
// Manages the PIXI application, viewport, and all sprite layers.
class TreeRenderer {
  constructor(container, onNodeClick) {
    this.container = container;
    this.onNodeClick = onNodeClick;
    this.app = null;
    this.viewport = null;
    this.sprites = null; // loaded sprite textures
    this.spatialHash = new SpatialHash(60);
    this.destroyed = false;

    // Layers (PIXI.Container)
    this.layers = {};

    // State
    this.treeData = null;
    this.positions = null;
    this.currentNodes = new Set();
    this.prevNodes = null;
    this.jewelSockets = {};
    this.showDiffs = true;
    this.showLabels = true;
  }

  async init(width, height) {
    this.app = new PIXI.Application({
      width,
      height,
      backgroundColor: 0x06070a,
      antialias: true,
      resolution: window.devicePixelRatio || 1,
      autoDensity: true,
    });

    this.container.appendChild(this.app.view);
    this.app.view.style.width = '100%';
    this.app.view.style.height = '100%';

    // Viewport for zoom/pan
    this.viewport = new Viewport({
      screenWidth: width,
      screenHeight: height,
      worldWidth: 10000,
      worldHeight: 10000,
      events: this.app.renderer.events,
    });

    this.viewport
      .drag({ mouseButtons: 'left' })
      .pinch()
      .wheel({ smooth: 5, percent: 0.08 })
      .clampZoom({ minScale: 0.05, maxScale: 4.0 })
      .decelerate({ friction: 0.92 });

    this.app.stage.addChild(this.viewport);

    // Create render layers in order
    const layerNames = [
      'background',
      'groupBg',
      'connectionsInactive',
      'connectionsActive',
      'nodesInactive',
      'nodesActive',
      'framesInactive',
      'framesActive',
      'diffGlow',
      'jewels',
      'timelessOverlay',
      'labels',
    ];
    for (const name of layerNames) {
      const layer = new PIXI.Container();
      this.layers[name] = layer;
      this.viewport.addChild(layer);
    }

    // Click/tap detection via the viewport's 'clicked' event
    this.viewport.on('clicked', (e) => {
      const worldPos = e.world;
      if (!worldPos) return;
      const hit = this.spatialHash.query(worldPos.x, worldPos.y);
      if (hit && this.onNodeClick) {
        const screenPos = this.viewport.toScreen(worldPos.x, worldPos.y);
        this.onNodeClick(screenPos.x, screenPos.y, hit);
      }
    });
  }

  async loadSprites(treeData) {
    try {
      this.sprites = await loadTreeSprites(treeData);
    } catch (err) {
      console.warn('[TreeRenderer] Sprite loading failed, using fallback rendering:', err.message);
      this.sprites = {};
    }
  }

  resize(width, height) {
    if (!this.app || this.destroyed) return;
    this.app.renderer.resize(width, height);
    this.viewport.resize(width, height);
  }

  update(treeData, positions, currentNodes, prevNodes, jewelSockets, showDiffs, showLabels, tattoos = {}) {
    this.treeData = treeData;
    this.positions = positions;
    this.currentNodes = currentNodes;
    this.prevNodes = prevNodes;
    this.jewelSockets = jewelSockets;
    this.showDiffs = showDiffs;
    this.showLabels = showLabels;
    this.tattoos = tattoos;
    this.render();
  }

  render() {
    if (!this.app || this.destroyed || !this.treeData || !this.positions) return;

    const { nodes: treeNodes } = this.treeData;
    const positions = this.positions;
    const currentNodes = this.currentNodes;
    const prevNodes = this.prevNodes;
    const allAllocated = new Set([...currentNodes, ...(prevNodes || [])]);
    const jewelSockets = this.jewelSockets;

    // Clear all layers
    for (const layer of Object.values(this.layers)) {
      layer.removeChildren();
    }
    this.spatialHash.clear();

    if (currentNodes.size === 0) return;

    // Node sizing constants (in world units).
    // Tree spans ~27000x22000 units. At zoom level 0.3835:
    //   normal icons = 34px → ~89 world units diameter
    //   notable frames = 76px → ~198 world units diameter
    //   keystone frames = 109px → ~284 world units diameter
    const SCALE = 1 / (this.treeData.imageZoomLevels?.[3] || 0.3835);
    const KEYSTONE_R = 55 * SCALE;
    const NOTABLE_R = 38 * SCALE;
    const SMALL_R = 17 * SCALE;
    const JEWEL_R = 40 * SCALE;
    const CONNECTION_WIDTH = 4 * SCALE;

    // --- Connections (inactive skeleton) ---
    const inactiveConnGfx = new PIXI.Graphics();
    inactiveConnGfx.lineStyle(CONNECTION_WIDTH * 0.4, 0x232d3c, 0.3);
    for (const [nodeId, node] of Object.entries(treeNodes)) {
      if (node.ascendancyName) continue;
      const from = positions[nodeId];
      if (!from) continue;
      for (const outId of (node.out || [])) {
        const outNode = treeNodes[outId];
        if (outNode?.ascendancyName) continue;
        const to = positions[outId];
        if (!to) continue;
        inactiveConnGfx.moveTo(from.x, from.y);
        inactiveConnGfx.lineTo(to.x, to.y);
      }
    }
    this.layers.connectionsInactive.addChild(inactiveConnGfx);

    // --- Active connections ---
    const activeConnGfx = new PIXI.Graphics();
    const greenConnGfx = new PIXI.Graphics();
    const redConnGfx = new PIXI.Graphics();
    activeConnGfx.lineStyle(CONNECTION_WIDTH, 0xc8b06a, 0.7);
    greenConnGfx.lineStyle(CONNECTION_WIDTH, 0x32e66e, 0.7);
    redConnGfx.lineStyle(CONNECTION_WIDTH, 0xe63c3c, 0.6);

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

        let gfx;
        if (this.showDiffs && (fromNew || toNew)) {
          gfx = greenConnGfx;
        } else if (this.showDiffs && (fromRemoved || toRemoved)) {
          gfx = redConnGfx;
        } else {
          gfx = activeConnGfx;
        }
        gfx.moveTo(from.x, from.y);
        gfx.lineTo(to.x, to.y);
      }
    }
    this.layers.connectionsActive.addChild(activeConnGfx);
    this.layers.connectionsActive.addChild(greenConnGfx);
    this.layers.connectionsActive.addChild(redConnGfx);

    // --- Unallocated nodes ---
    for (const [nodeId, pos] of Object.entries(positions)) {
      if (allAllocated.has(nodeId)) continue;
      const node = treeNodes[nodeId];
      if (!node || node.classStartIndex !== undefined || node.ascendancyName || node.isBloodline) continue;

      const r = node.isKeystone ? KEYSTONE_R : node.isNotable ? NOTABLE_R : SMALL_R;
      this._drawNode(nodeId, node, pos, r, false, false, false);
    }

    // --- Allocated nodes ---
    for (const nodeId of allAllocated) {
      // Skip jewel socket nodes — drawn separately by _drawJewel below
      if (jewelSockets[nodeId]) continue;
      const node = treeNodes[nodeId];
      if (!node || node.ascendancyName) continue;
      const pos = positions[nodeId];
      if (!pos) continue;

      const inCurrent = currentNodes.has(nodeId);
      const inPrev = prevNodes?.has(nodeId);
      const isNew = this.showDiffs && prevNodes && inCurrent && !inPrev;
      const isRemoved = this.showDiffs && prevNodes && !inCurrent && inPrev;

      // When diffs are off, skip removed nodes
      if (!this.showDiffs && prevNodes && !inCurrent && inPrev) continue;

      const r = node.isKeystone ? KEYSTONE_R : node.isNotable ? NOTABLE_R : SMALL_R;
      this._drawNode(nodeId, node, pos, r, true, isNew, isRemoved);
    }

    // --- Jewel sockets ---
    for (const [nodeId, jewel] of Object.entries(jewelSockets)) {
      const pos = positions[nodeId];
      if (!pos) continue;
      const isNewJewel = this.showDiffs && prevNodes && currentNodes.has(nodeId) && !prevNodes.has(nodeId);
      const isRemovedJewel = this.showDiffs && prevNodes && !currentNodes.has(nodeId) && prevNodes.has(nodeId);
      this._drawJewel(nodeId, jewel, pos, JEWEL_R, isNewJewel, isRemovedJewel);
    }

    // --- Tattoo markers ---
    const tattoos = this.tattoos || {};
    for (const [nodeId, tattoo] of Object.entries(tattoos)) {
      const pos = positions[nodeId];
      if (!pos) continue;
      const r = NOTABLE_R; // Use notable-sized radius so it's visible at all zoom levels
      const gfx = new PIXI.Graphics();
      // Large outer glow (very visible)
      gfx.beginFill(0x00ffee, 0.12);
      gfx.drawCircle(pos.x, pos.y, r * 2.0);
      gfx.endFill();
      // Bright thick ring
      gfx.lineStyle(r * 0.2, 0x00ffcc, 0.9);
      gfx.drawCircle(pos.x, pos.y, r * 1.3);
      // Inner bright fill
      gfx.beginFill(0x00eedd, 0.35);
      gfx.drawCircle(pos.x, pos.y, r * 0.8);
      gfx.endFill();
      this.layers.timelessOverlay.addChild(gfx);
      // Register tooltip
      this.spatialHash.insert({
        id: `tattoo-${nodeId}`, x: pos.x, y: pos.y, r: r * 1.5,
        node: { name: tattoo.dn, isNotable: false, sd: tattoo.stats },
        tattooInfo: { original: treeNodes[nodeId]?.name || nodeId },
      });
    }

    // --- Timeless jewel overlays (async, renders when data loads) ---
    this._drawTimelessOverlays(positions, treeNodes, SCALE);

    // --- Labels ---
    if (this.showLabels) {
      this._drawLabels(treeNodes, positions, allAllocated, currentNodes, prevNodes, SCALE);
    }

    // --- Summary overlay (screen-space) ---
    this._drawOverlay(currentNodes, prevNodes);

    // Fit viewport to allocated nodes on first render
    if (!this._hasInitialFit) {
      this._fitToAllocated(positions, allAllocated);
      this._hasInitialFit = true;
    }
  }

  _drawNode(nodeId, node, pos, r, active, isNew, isRemoved) {
    const hasSprites = this.sprites && Object.keys(this.sprites).length > 0;

    // Try to render with sprite
    if (hasSprites && node.icon) {
      const texture = getNodeIconTexture(this.sprites, node, active);
      if (texture) {
        const sprite = new PIXI.Sprite(texture);
        sprite.anchor.set(0.5);
        sprite.x = pos.x;
        sprite.y = pos.y;
        // Scale sprite to fit the node radius
        const maxDim = Math.max(texture.width, texture.height);
        const scale = (r * 2 * 0.85) / maxDim;
        sprite.width = texture.width * scale;
        sprite.height = texture.height * scale;
        if (!active) sprite.alpha = 0.35;
        if (isRemoved) sprite.alpha = 0.6;
        // Don't tint icons — keep original art, use glow for diff indication

        const layer = active ? this.layers.nodesActive : this.layers.nodesInactive;
        layer.addChild(sprite);

        // Draw frame
        const frameTex = getFrameTexture(this.sprites, node, active);
        if (frameTex) {
          const frame = new PIXI.Sprite(frameTex);
          frame.anchor.set(0.5);
          frame.x = pos.x;
          frame.y = pos.y;
          const frameScale = (r * 2 * 1.15) / Math.max(frameTex.width, frameTex.height);
          frame.width = frameTex.width * frameScale;
          frame.height = frameTex.height * frameScale;
          if (!active) frame.alpha = 0.25;
          // Tint the frame (not the icon) for diffs
          if (isRemoved) { frame.tint = 0xff4444; frame.alpha = 0.8; }
          if (isNew) { frame.tint = 0x44ff88; frame.alpha = 0.9; }

          const frameLayer = active ? this.layers.framesActive : this.layers.framesInactive;
          frameLayer.addChild(frame);
        }

        // Diff glow ring behind the node
        if (isNew || isRemoved) {
          const glow = new PIXI.Graphics();
          glow.beginFill(isNew ? 0x32e66e : 0xe63c3c, 0.2);
          glow.drawCircle(pos.x, pos.y, r * 1.8);
          glow.endFill();
          // Also draw a bright ring
          glow.lineStyle(r * 0.15, isNew ? 0x33ee77 : 0xdd4444, 0.6);
          glow.drawCircle(pos.x, pos.y, r * 1.3);
          this.layers.diffGlow.addChild(glow);
        }

        // Hit area
        this.spatialHash.insert({
          id: nodeId, x: pos.x, y: pos.y, r: r * 1.3,
          node, isUnallocated: !active,
        });
        return;
      }
    }

    // Fallback: draw circles (same as old Canvas 2D)
    const gfx = new PIXI.Graphics();

    if (isNew || isRemoved) {
      gfx.beginFill(isNew ? 0x32e66e : 0xe63c3c, 0.12);
      gfx.drawCircle(pos.x, pos.y, r * 1.5);
      gfx.endFill();
    }

    const color = !active ? (node.isKeystone ? 0x5a6482 : node.isNotable ? 0x505f7d : 0x465573)
      : isRemoved ? 0xdd4444 : isNew ? 0x33ee77 : 0xc8b06a;
    const alpha = active ? 1.0 : 0.45;

    gfx.beginFill(color, alpha);
    gfx.drawCircle(pos.x, pos.y, r);
    gfx.endFill();

    if (node.isNotable || node.isKeystone) {
      const strokeColor = !active ? 0x647396
        : isNew ? 0x33ee77 : isRemoved ? 0xdd4444 : 0xe8d48a;
      const strokeAlpha = active ? 1.0 : 0.35;
      gfx.lineStyle(node.isKeystone ? 3 : 2, strokeColor, strokeAlpha);
      gfx.drawCircle(pos.x, pos.y, r);
    }

    const layer = active ? this.layers.nodesActive : this.layers.nodesInactive;
    layer.addChild(gfx);

    // Hit area
    if (node.isKeystone || node.isNotable || node.name || active) {
      this.spatialHash.insert({
        id: nodeId, x: pos.x, y: pos.y, r: r * 1.3,
        node, isUnallocated: !active,
      });
    }
  }

  _drawJewel(nodeId, jewel, pos, r, isNew = false, isRemoved = false) {
    const isCluster = jewel.baseType.toLowerCase().includes('cluster');
    const isUnique = jewel.rarity === 'Unique';
    const hasSprites = this.sprites && Object.keys(this.sprites).length > 0;

    // Diff glow ring behind the jewel
    if (isNew || isRemoved) {
      const glow = new PIXI.Graphics();
      glow.beginFill(isNew ? 0x32e66e : 0xe63c3c, 0.2);
      glow.drawCircle(pos.x, pos.y, r * 2.0);
      glow.endFill();
      glow.lineStyle(r * 0.15, isNew ? 0x33ee77 : 0xdd4444, 0.6);
      glow.drawCircle(pos.x, pos.y, r * 1.5);
      this.layers.diffGlow.addChild(glow);
    }

    // Try GGG jewel socket sprite first
    let drawnSprite = false;
    if (hasSprites) {
      // Try specific jewel socket textures from the 'jewel' sprite sheet
      const colorKey = isUnique ? 'Red' : isCluster ? 'Blue' : 'Blue';
      const tex = this.sprites[`JewelSocketActive${colorKey}Alt`]
        || this.sprites[`JewelSocketActive${colorKey}`]
        || this.sprites['JewelSocketActiveBlueAlt']
        || this.sprites['JewelSocketActiveBlue'];
      if (tex) {
        const sprite = new PIXI.Sprite(tex);
        sprite.anchor.set(0.5);
        sprite.x = pos.x;
        sprite.y = pos.y;
        const maxDim = Math.max(tex.width, tex.height);
        const scale = (r * 2.4) / maxDim;
        sprite.width = tex.width * scale;
        sprite.height = tex.height * scale;
        if (isNew) sprite.tint = 0x44ff88;
        else if (isRemoved) sprite.tint = 0xff4444;
        else if (isUnique) sprite.tint = 0xffaa44;
        else if (isCluster) sprite.tint = 0xbb88ff;
        if (isRemoved) sprite.alpha = 0.6;
        this.layers.jewels.addChild(sprite);
        drawnSprite = true;
      }
    }

    // Fallback: colored circle with border
    if (!drawnSprite) {
      const gfx = new PIXI.Graphics();
      const fillColor = isNew ? 0x2a8a4a : isRemoved ? 0x8a2a2a
        : isCluster ? 0x6a3fbf : isUnique ? 0xaf6025 : 0x3a7fc2;
      const strokeColor = isNew ? 0x33ee77 : isRemoved ? 0xdd4444
        : isCluster ? 0x9b6fff : isUnique ? 0xe8a550 : 0x5ab0ff;
      gfx.lineStyle(r * 0.12, strokeColor, 1);
      gfx.beginFill(fillColor, isRemoved ? 0.5 : 0.85);
      gfx.drawCircle(pos.x, pos.y, r);
      gfx.endFill();
      this.layers.jewels.addChild(gfx);
    }

    // Hit area — don't put stats on node.sd (avoids duplicate display in tooltip)
    const jewelStatLines = (jewel.stats || []).map(s => typeof s === 'string' ? s : (s.line || s));
    this.spatialHash.insert({
      id: `jewel-${nodeId}`, x: pos.x, y: pos.y, r: r * 1.4,
      node: {
        name: jewel.name,
        isKeystone: false, isNotable: false, isJewel: true, isJewelSocket: true,
        sd: [], // empty — stats shown via jewelInfo only
      },
      jewelInfo: {
        name: jewel.name,
        baseType: jewel.baseType,
        rarity: jewel.rarity,
        stats: jewelStatLines,
      },
    });
  }

  async _drawTimelessOverlays(positions, treeNodes, SCALE) {
    const layer = this.layers.timelessOverlay;
    layer.removeChildren();

    for (const [nodeId, jewel] of Object.entries(this.jewelSockets)) {
      const parsed = parseTimelessJewel(jewel);
      if (!parsed) continue;

      const socketPos = positions[nodeId];
      if (!socketPos) continue;

      // Draw radius circle
      const radiusGfx = new PIXI.Graphics();
      const typeColors = { 2: 0xff4444, 3: 0x44cc44, 4: 0x4488ff, 5: 0xccaa44, 6: 0x8844cc };
      const color = typeColors[parsed.type] || 0x888888;
      radiusGfx.lineStyle(3 * SCALE, color, 0.4);
      radiusGfx.drawCircle(socketPos.x, socketPos.y, 1800);
      radiusGfx.beginFill(color, 0.03);
      radiusGfx.drawCircle(socketPos.x, socketPos.y, 1800);
      radiusGfx.endFill();
      layer.addChild(radiusGfx);

      // Load transforms from server API
      try {
        const nodesInRadius = getNodesInRadius(nodeId, positions, treeNodes);
        const nodeIds = nodesInRadius.map(n => parseInt(n.nodeId));
        const transforms = await getTransforms(parsed.type, parsed.seed, nodeIds);

        for (const t of transforms) {
          const pos = positions[String(t.nodeId)];
          if (!pos) continue;

          if (t.isKeystone) {
            const gfx = new PIXI.Graphics();
            gfx.beginFill(0xff8800, 0.25);
            gfx.drawCircle(pos.x, pos.y, 55 * SCALE * 1.5);
            gfx.endFill();
            gfx.lineStyle(2 * SCALE, 0xff8800, 0.6);
            gfx.drawCircle(pos.x, pos.y, 55 * SCALE * 1.3);
            layer.addChild(gfx);
          } else if (t.isReplacement) {
            const gfx = new PIXI.Graphics();
            const r = 12 * SCALE;
            gfx.beginFill(0xe8b84a, 0.9);
            gfx.moveTo(pos.x, pos.y - r);
            gfx.lineTo(pos.x + r * 0.7, pos.y);
            gfx.lineTo(pos.x, pos.y + r);
            gfx.lineTo(pos.x - r * 0.7, pos.y);
            gfx.closePath();
            gfx.endFill();
            layer.addChild(gfx);
            this.spatialHash.insert({
              id: `timeless-${t.nodeId}`, x: pos.x, y: pos.y, r: 20 * SCALE,
              node: { name: t.dn, isNotable: true, sd: t.sd },
              timelessInfo: { original: nodesInRadius.find(n => String(n.nodeId) === String(t.nodeId))?.name || t.nodeId, type: 'replacement' },
            });
          } else {
            // Stat addition
            const gfx = new PIXI.Graphics();
            const r = 8 * SCALE;
            gfx.beginFill(0x44ccaa, 0.85);
            gfx.drawCircle(pos.x + 20 * SCALE, pos.y - 20 * SCALE, r);
            gfx.endFill();
            layer.addChild(gfx);
            const origName = nodesInRadius.find(n => String(n.nodeId) === String(t.nodeId))?.name || t.nodeId;
            this.spatialHash.insert({
              id: `timeless-add-${t.nodeId}`, x: pos.x + 20 * SCALE, y: pos.y - 20 * SCALE, r: 12 * SCALE,
              node: { name: `${origName} + ${t.dn}`, isNotable: false, sd: t.sd },
              timelessInfo: { original: origName, type: 'addition' },
            });
          }
          // Small nodes: no marker, but could add subtle indicator
        }
      } catch (err) {
        console.warn('Failed to load timeless jewel data:', err.message);
      }
    }
  }

  _drawLabels(treeNodes, positions, allAllocated, currentNodes, prevNodes, SCALE) {
    for (const nodeId of allAllocated) {
      if (this.jewelSockets[nodeId]) continue; // jewels have their own tooltip
      const node = treeNodes[nodeId];
      if (!node || node.ascendancyName) continue;
      const pos = positions[nodeId];
      if (!pos) continue;

      const inCurrent = currentNodes.has(nodeId);
      const inPrev = prevNodes?.has(nodeId);
      const isNew = this.showDiffs && prevNodes && inCurrent && !inPrev;
      const isRemoved = this.showDiffs && prevNodes && !inCurrent && inPrev;
      if (!this.showDiffs && prevNodes && !inCurrent && inPrev) continue;

      // Only label keystones, notables, and diff'd nodes
      if (!node.isKeystone && !node.isNotable && !isNew && !isRemoved) continue;

      const name = node.name || nodeId;
      const color = isRemoved ? '#ff6666' : isNew ? '#44ff88' : '#e8d48a';
      const fontSize = (node.isKeystone ? 16 : node.isNotable ? 13 : 11) * SCALE;
      const r = (node.isKeystone ? 55 : node.isNotable ? 38 : 17) * SCALE;

      const text = new PIXI.Text(name, {
        fontFamily: 'system-ui, -apple-system, sans-serif',
        fontSize,
        fontWeight: 'bold',
        fill: color,
        align: 'center',
        dropShadow: true,
        dropShadowColor: '#000000',
        dropShadowBlur: 4,
        dropShadowDistance: 0,
      });
      text.anchor.set(0.5, 1);
      text.x = pos.x;
      text.y = pos.y - r - 6;
      this.layers.labels.addChild(text);
    }
  }

  _drawOverlay(currentNodes, prevNodes) {
    // Remove old overlay
    if (this._overlayContainer) {
      this.app.stage.removeChild(this._overlayContainer);
    }
    const overlay = new PIXI.Container();
    this._overlayContainer = overlay;

    if (this.showDiffs && prevNodes) {
      const jewelIds = new Set(Object.keys(this.jewelSockets));
      const added = [...currentNodes].filter(n => !prevNodes.has(n) && !jewelIds.has(n)).length;
      const removed = [...prevNodes].filter(n => !currentNodes.has(n) && !jewelIds.has(n)).length;
      const addedJewels = [...currentNodes].filter(n => !prevNodes.has(n) && jewelIds.has(n)).length;

      let yOff = 12;
      const addLabel = addedJewels > 0 ? `+${added} nodes, +${addedJewels} jewels` : `+${added} nodes`;
      const addText = new PIXI.Text(addLabel, {
        fontFamily: 'system-ui', fontSize: 12, fontWeight: 'bold', fill: '#33ee77',
        dropShadow: true, dropShadowColor: '#000', dropShadowBlur: 4, dropShadowDistance: 0,
      });
      addText.x = 12; addText.y = yOff;
      overlay.addChild(addText);
      yOff += 18;

      if (removed > 0) {
        const remText = new PIXI.Text(`-${removed} nodes`, {
          fontFamily: 'system-ui', fontSize: 12, fontWeight: 'bold', fill: '#ff5555',
          dropShadow: true, dropShadowColor: '#000', dropShadowBlur: 4, dropShadowDistance: 0,
        });
        remText.x = 12; remText.y = yOff;
        overlay.addChild(remText);
        yOff += 18;
      }

      const totalText = new PIXI.Text(`${currentNodes.size} total`, {
        fontFamily: 'system-ui', fontSize: 12, fontWeight: 'bold', fill: '#c8b06a',
        dropShadow: true, dropShadowColor: '#000', dropShadowBlur: 4, dropShadowDistance: 0,
      });
      totalText.x = 12; totalText.y = yOff;
      overlay.addChild(totalText);
    } else {
      const text = new PIXI.Text(`${currentNodes.size} nodes`, {
        fontFamily: 'system-ui', fontSize: 12, fontWeight: 'bold', fill: '#c8b06a',
        dropShadow: true, dropShadowColor: '#000', dropShadowBlur: 4, dropShadowDistance: 0,
      });
      text.x = 12; text.y = 12;
      overlay.addChild(text);
    }

    this.app.stage.addChild(overlay);
  }

  _fitToAllocated(positions, allAllocated) {
    if (!this.viewport || allAllocated.size === 0) return;
    const { nodes: treeNodes } = this.treeData;

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

    if (!isFinite(minX)) return;

    const pad = Math.max((maxX - minX) * 0.12, (maxY - minY) * 0.12, 200);
    const worldW = maxX - minX + pad * 2;
    const worldH = maxY - minY + pad * 2;
    const centerX = (minX + maxX) / 2;
    const centerY = (minY + maxY) / 2;

    const scaleX = this.viewport.screenWidth / worldW;
    const scaleY = this.viewport.screenHeight / worldH;
    const scale = Math.min(scaleX, scaleY);

    this.viewport.setZoom(scale, true);
    this.viewport.moveCenter(centerX, centerY);
  }

  resetView() {
    if (!this.treeData || !this.positions) return;
    this._hasInitialFit = false;
    const allAllocated = new Set([...this.currentNodes, ...(this.prevNodes || [])]);
    this._fitToAllocated(this.positions, allAllocated);
  }

  destroy() {
    this.destroyed = true;
    if (this._overlayContainer) {
      this.app?.stage?.removeChild(this._overlayContainer);
    }
    if (this.app) {
      this.app.destroy(true, { children: true, texture: false, baseTexture: false });
      this.app = null;
    }
    this.viewport = null;
  }
}

// ====== React Component ======

export default function PassiveTree({ specs, classId }) {
  const pixiContainerRef = useRef(null);
  const rendererRef = useRef(null);
  const [treeData, setTreeData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [spritesLoading, setSpritesLoading] = useState(false);
  const [selectedSpec, setSelectedSpec] = useState(() => {
    try { return parseInt(localStorage.getItem('pob-trade-tree') || '0') || 0; } catch { return 0; }
  });
  const [ascendancyLabs, setAscendancyLabs] = useState(null);
  const [tooltip, setTooltip] = useState(null);
  const tooltipTimer = useRef(null);
  const [showDiffs, setShowDiffs] = useState(true);
  const [showLabels, setShowLabels] = useState(true);
  const [ascViewClass, setAscViewClass] = useState(null);

  // Load tree data
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

  // Tooltip handler (called from PIXI renderer)
  const handleNodeClick = useCallback((screenX, screenY, hit) => {
    if (tooltipTimer.current) clearTimeout(tooltipTimer.current);
    const node = hit.node;
    const stats = (node.sd || node.reminderText || []).slice(0, 12);
    const isTattoo = !!hit.tattooInfo;
    const isTimeless = !!hit.timelessInfo;
    setTooltip({
      x: screenX, y: screenY,
      name: node.name || '',
      stats,
      isKeystone: node.isKeystone,
      isNotable: node.isNotable,
      isJewel: node.isJewel,
      isUnallocated: hit.isUnallocated,
      jewelInfo: hit.jewelInfo,
      tattooInfo: hit.tattooInfo || null,
      timelessInfo: hit.timelessInfo || null,
      nodeType: isTattoo ? 'Tattoo' : isTimeless ? 'Timeless' : node.isKeystone ? 'Keystone' : node.isNotable ? 'Notable' : node.isMastery ? 'Mastery' : node.isJewelSocket ? 'Jewel Socket' : 'Passive',
    });
    tooltipTimer.current = setTimeout(() => setTooltip(null), 8000);
  }, []);

  // Initialize PIXI renderer
  useEffect(() => {
    const container = pixiContainerRef.current;
    if (!container || !treeData) return;

    const renderer = new TreeRenderer(container, handleNodeClick);
    rendererRef.current = renderer;

    const width = container.clientWidth || 800;
    const height = container.clientHeight || 600;

    renderer.init(width, height).then(async () => {
      // Load sprites in background
      setSpritesLoading(true);
      await renderer.loadSprites(treeData);
      setSpritesLoading(false);

      // Trigger initial render
      if (specs && specs.length > 0) {
        const idx = Math.min(selectedSpec, specs.length - 1);
        const positions = computeAllPositions(treeData);
        const currentNodes = specs[idx]?.nodes || new Set();
        const prevNodes = idx > 0 ? (specs[idx - 1]?.nodes || new Set()) : null;
        const jewelSockets = specs[idx]?.jewelSockets || {};
        const tattoos = specs[idx]?.tattoos || {};
        renderer.update(treeData, positions, currentNodes, prevNodes, jewelSockets, showDiffs, showLabels, tattoos);
      }
    });

    // Resize observer
    const obs = new ResizeObserver((entries) => {
      for (const entry of entries) {
        const { width, height } = entry.contentRect;
        if (width > 0 && height > 0) {
          renderer.resize(width, height);
        }
      }
    });
    obs.observe(container);

    return () => {
      obs.disconnect();
      renderer.destroy();
      rendererRef.current = null;
    };
  }, [treeData, handleNodeClick]); // Only re-init when treeData loads

  // Update renderer when state changes
  useEffect(() => {
    const renderer = rendererRef.current;
    if (!renderer || !treeData || !specs || specs.length === 0) return;

    const positions = computeAllPositions(treeData);
    const idx = Math.min(selectedSpec, specs.length - 1);
    const currentNodes = specs[idx]?.nodes || new Set();
    const prevNodes = idx > 0 ? (specs[idx - 1]?.nodes || new Set()) : null;
    const jewelSockets = specs[idx]?.jewelSockets || {};
    const tattoos = specs[idx]?.tattoos || {};

    renderer.update(treeData, positions, currentNodes, prevNodes, jewelSockets, showDiffs, showLabels, tattoos);
  }, [treeData, specs, selectedSpec, showDiffs, showLabels]);

  // Compute ascendancy for selected spec
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

  // Jewel list with cluster sub-tree generation and socket grouping
  const jewelList = useMemo(() => {
    if (!treeData || !specs || specs.length === 0) return [];
    const spec = specs[Math.min(selectedSpec, specs.length - 1)];
    const sockets = spec.jewelSockets || {};
    const positions = cachedPositions || {};
    const treeNodes = treeData.nodes;

    const allEntries = [];

    for (const [nodeId, item] of Object.entries(sockets)) {
      const bt = (item.baseType || '').toLowerCase();
      const isCluster = bt.includes('cluster');
      const treeNode = treeNodes[nodeId];
      const expansionSize = treeNode?.expansionJewel?.size; // 2=Large, 1=Medium, undefined=Basic

      // For rare cluster jewels, PoB uses "New Item" as name — show baseType instead
      const displayName = (item.rarity === 'Rare' || item.rarity === 'RARE' || item.name === 'New Item')
        ? (item.baseType || item.name)
        : item.name;

      const entry = {
        nodeId,
        name: displayName,
        baseType: item.baseType,
        rarity: item.rarity,
        stats: (item.stats || []).map(s => s.line || s),
        isCluster,
        isLargeCluster: bt.includes('large cluster'),
        isMediumCluster: bt.includes('medium cluster'),
        isSmallCluster: bt.includes('small cluster'),
        hasPosition: !!positions[nodeId],
        subJewels: [],
        socketSize: expansionSize === 2 ? 'Large' : expansionSize === 1 ? 'Medium' : 'Basic',
        // For proxied sockets: which large socket is this medium socket connected to?
        parentSocketId: treeNode?.expansionJewel?.parent,
      };

      if (isCluster) {
        const cluster = parseClusterJewel(item);
        entry.clusterNodes = generateClusterNodes(cluster);
        entry.clusterSize = cluster.size;
        entry.clusterNodeCount = cluster.nodeCount;
        entry.clusterNotables = cluster.notables;
        entry.clusterSmallGrants = cluster.smallGrants;
        entry.clusterSocketCount = cluster.socketCount;
      }

      allEntries.push(entry);
    }

    // Group: find medium sockets that are proxied through large sockets
    // GGG tree data has expansionJewel.parent pointing to the large socket nodeId
    const largeSocketEntries = allEntries.filter(e => e.socketSize === 'Large');
    const mediumSocketEntries = allEntries.filter(e => e.socketSize === 'Medium');
    const basicSocketEntries = allEntries.filter(e => e.socketSize === 'Basic');

    // For each large cluster, find medium sockets connected to it via expansionJewel.parent
    for (const large of largeSocketEntries) {
      if (!large.isCluster) continue;
      // Find mediums whose parent is this large socket
      const connectedMediums = mediumSocketEntries.filter(m => {
        const treeNode = treeNodes[m.nodeId];
        return String(treeNode?.expansionJewel?.parent) === String(large.nodeId);
      });
      for (const med of connectedMediums) {
        large.subJewels.push(med);
        med._nested = true;
      }
    }

    // For medium clusters, find small sockets connected
    for (const med of mediumSocketEntries) {
      if (!med.isCluster || med._nested === undefined) continue;
      // Small sockets connected to this medium
      // (unlikely in GGG tree but check anyway)
    }

    // Build final list: large sockets first (with nested mediums), then unattached mediums, then basics
    const result = [];

    for (const large of largeSocketEntries) {
      result.push(large);
    }
    for (const med of mediumSocketEntries) {
      if (!med._nested) result.push(med);
    }
    for (const basic of basicSocketEntries) {
      result.push(basic);
    }

    // Add remaining jewels without GGG positions (socketed in cluster sub-sockets)
    // Only nest sub-cluster jewels under parents — regular jewels (Grand Spectrum etc.) go to top level
    for (const entry of allEntries) {
      if (!entry.hasPosition && !result.includes(entry)) {
        if (entry.isCluster) {
          const parent = largeSocketEntries.find(l => l.isCluster);
          if (parent) parent.subJewels.push(entry);
          else result.push(entry);
        } else {
          result.push(entry);
        }
      }
    }

    return result;
  }, [treeData, specs, selectedSpec]);

  // Tattoo summary for selected spec
  const tattooSummary = useMemo(() => {
    if (!specs || specs.length === 0) return [];
    const spec = specs[Math.min(selectedSpec, specs.length - 1)];
    const tattoos = spec.tattoos || {};
    const entries = Object.entries(tattoos);
    if (entries.length === 0) return [];

    // Group by tattoo name
    const grouped = {};
    for (const [nodeId, t] of entries) {
      if (!grouped[t.dn]) grouped[t.dn] = { dn: t.dn, stats: t.stats, count: 0, nodeIds: [] };
      grouped[t.dn].count++;
      grouped[t.dn].nodeIds.push(nodeId);
    }
    return Object.values(grouped).sort((a, b) => b.count - a.count);
  }, [specs, selectedSpec]);

  const resetView = useCallback(() => {
    rendererRef.current?.resetView();
  }, []);

  // Build a notable name → stats lookup from GGG tree data (for cluster jewel notable tooltips)
  const notableLookup = useMemo(() => {
    if (!treeData) return {};
    const lookup = {};
    for (const [, node] of Object.entries(treeData.nodes)) {
      if (node.isNotable && node.name && (node.stats || node.sd)) {
        lookup[node.name] = node.stats || node.sd || [];
      }
    }
    return lookup;
  }, [treeData]);

  // --- Jewel card component (needs its own state for expand) ---
  function JewelEntry({ jewel, depth = 0 }) {
    const [expandedNotable, setExpandedNotable] = useState(null);
    const iu = jewel.rarity === 'Unique';
    const ic = jewel.isCluster;
    const clusterNodes = jewel.clusterNodes || [];
    const notables = clusterNodes.filter(n => n.type === 'Notable');
    const socketCount = clusterNodes.filter(n => n.type === 'Socket').length;
    const smallCount = clusterNodes.filter(n => n.type === 'Normal').length;
    const sizeTag = jewel.isLargeCluster ? 'L' : jewel.isMediumCluster ? 'M' : jewel.isSmallCluster ? 'S' : '';

    return (
      <div className={depth > 0 ? 'ml-3 pl-2.5 border-l border-purple-800/30' : ''}>
        <div className={`flex items-start gap-2 py-1.5 px-2.5 rounded-lg ${depth > 0 ? 'bg-[#0c0d11]' : 'bg-[#0a0b0e] border border-slate-800/60'}`}>
          <span className={`w-2 h-2 mt-0.5 shrink-0 ${ic ? 'rounded-sm rotate-45 bg-purple-500' : iu ? 'rounded-sm rotate-45 bg-orange-500' : 'rounded-full bg-blue-500'}`} />
          <div className="flex-1 min-w-0">
            {/* Header: name + cluster info */}
            <div className="flex items-center gap-1.5 flex-wrap">
              <span className={`text-[10px] font-bold leading-tight ${iu ? 'text-orange-400' : ic ? 'text-purple-300' : 'text-blue-300'}`}>
                {jewel.name}
              </span>
              {sizeTag && <span className="text-[7px] font-black text-purple-500/50 bg-purple-900/20 px-1 rounded">{sizeTag}</span>}
              {ic && jewel.clusterNodeCount > 0 && (
                <span className="text-[8px] text-slate-600">{jewel.clusterNodeCount} passives</span>
              )}
            </div>
            {/* Cluster notables — clickable to expand */}
            {ic && notables.length > 0 && (
              <div className="flex flex-wrap gap-1 mt-1">
                {notables.map((cn, ci) => (
                  <button
                    key={ci}
                    onClick={() => setExpandedNotable(expandedNotable === cn.name ? null : cn.name)}
                    className={`text-[8px] font-semibold px-1.5 py-0.5 rounded cursor-pointer transition-colors ${
                      expandedNotable === cn.name
                        ? 'text-amber-200 bg-amber-800/40 border border-amber-700/50'
                        : 'text-amber-300/90 bg-amber-900/20 hover:bg-amber-900/35'
                    }`}
                  >{cn.name}</button>
                ))}
                {socketCount > 0 && (
                  <span className="text-[8px] text-blue-400/60 bg-blue-900/15 px-1.5 py-0.5 rounded">{socketCount} socket{socketCount > 1 ? 's' : ''}</span>
                )}
                {smallCount > 0 && (
                  <span className="text-[8px] text-slate-500 py-0.5">{smallCount} small</span>
                )}
              </div>
            )}
            {/* Expanded notable stats — from GGG tree data */}
            {expandedNotable && (
              <div className="mt-1 ml-1 pl-2 border-l-2 border-amber-800/30">
                {(notableLookup[expandedNotable] || []).length > 0 ? (
                  notableLookup[expandedNotable].map((s, si) => (
                    <div key={si} className="text-[8px] text-amber-300/70 leading-snug">{s}</div>
                  ))
                ) : (
                  <div className="text-[8px] text-amber-300/50 italic">Stats not available</div>
                )}
              </div>
            )}
            {/* Cluster: small passive grant */}
            {ic && (jewel.clusterSmallGrants || []).length > 0 && (
              <div className="text-[8px] text-slate-500 mt-0.5 leading-tight">
                {jewel.clusterSmallGrants.map(s => s.replace(/Added Small Passive Skills (also )?grant:\s*/i, '')).join(', ')}
              </div>
            )}
            {/* Non-cluster: stat lines */}
            {!ic && jewel.stats.length > 0 && (
              <div className="mt-0.5">
                {jewel.stats.slice(0, 4).map((s, si) => (
                  <div key={si} className="text-[8px] text-blue-300/60 leading-snug">{s}</div>
                ))}
                {jewel.stats.length > 4 && <span className="text-[7px] text-slate-600">+{jewel.stats.length - 4} more</span>}
              </div>
            )}
          </div>
        </div>
        {jewel.subJewels?.length > 0 && (
          <div className="mt-1 space-y-1">
            {jewel.subJewels.map((sub, si) => <JewelEntry key={si} jewel={sub} depth={depth + 1} />)}
          </div>
        )}
      </div>
    );
  }

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
          {spritesLoading && (
            <span className="text-[9px] text-slate-600 animate-pulse">Loading sprites...</span>
          )}
        </div>
        {specs.length > 1 && (
          <div className="flex gap-2 items-center flex-wrap">
            <select
              value={selectedSpec}
              onChange={e => { const v = +e.target.value; setSelectedSpec(v); try { localStorage.setItem('pob-trade-tree', String(v)); } catch {} rendererRef.current && (rendererRef.current._hasInitialFit = false); }}
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
      <div className="relative" style={{ height: 600 }}>
        {loading ? (
          <div className="flex items-center justify-center h-full text-slate-500 text-xs">
            Loading tree data...
          </div>
        ) : (
          <div ref={pixiContainerRef} className="w-full h-full" />
        )}
        {tooltip && (
          <div
            className="absolute z-10 pointer-events-none animate-fade-in"
            style={{
              left: Math.min(Math.max(tooltip.x, 140), (pixiContainerRef.current?.clientWidth || 400) - 140),
              top: Math.max(tooltip.y - 14, 8),
              transform: 'translate(-50%, -100%)',
            }}
          >
            <div className="bg-[#1a1c28]/95 border border-slate-600 rounded-lg px-3 py-2.5 shadow-2xl max-w-[300px] backdrop-blur-sm">
              <div className="flex items-center gap-2 mb-1">
                {tooltip.nodeType && (
                  <span className={`text-[8px] font-bold uppercase px-1.5 py-0.5 rounded ${
                    tooltip.tattooInfo ? 'bg-cyan-900/40 text-cyan-300' :
                    tooltip.timelessInfo ? 'bg-amber-900/40 text-amber-300' :
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
              <div className={`text-xs font-black mb-1 ${
                tooltip.tattooInfo ? 'text-cyan-300' :
                tooltip.timelessInfo ? 'text-amber-300' :
                tooltip.isJewel ? 'text-orange-400' :
                tooltip.isKeystone ? 'text-amber-300' :
                tooltip.isNotable ? 'text-[#e8d48a]' :
                tooltip.isUnallocated ? 'text-slate-400' :
                'text-slate-200'
              }`}>
                {tooltip.name || 'Passive Node'}
              </div>
              {(tooltip.tattooInfo || tooltip.timelessInfo) && (
                <div className="text-[9px] text-slate-500 mb-1">
                  Replaces: <span className="text-slate-400">{tooltip.tattooInfo?.original || tooltip.timelessInfo?.original}</span>
                </div>
              )}
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
              {tooltip.stats.length > 0 && (
                <div className="space-y-0.5">
                  {tooltip.stats.map((s, i) => (
                    <div key={i} className="text-[10px] text-blue-300/80 leading-tight">{s}</div>
                  ))}
                </div>
              )}
              {tooltip.stats.length === 0 && !tooltip.jewelInfo && !tooltip.name && (
                <div className="text-[9px] text-slate-500 italic">No description available</div>
              )}
            </div>
          </div>
        )}
      </div>
      {jewelList.length > 0 && (
        <div className="px-5 py-3 border-t border-slate-800/50 bg-[#0d0e12]">
          <div className="text-[9px] font-black text-slate-500 uppercase tracking-widest mb-2">
            Tree Jewels <span className="text-slate-600 font-normal">({jewelList.length})</span>
          </div>
          <div className="grid gap-1.5">
            {jewelList.map((j, ji) => <JewelEntry key={ji} jewel={j} depth={0} />)}
          </div>
        </div>
      )}
      {tattooSummary.length > 0 && (
        <div className="px-5 py-3 border-t border-slate-800/50 bg-[#0d0e12]">
          <div className="text-[9px] font-black text-slate-500 uppercase tracking-widest mb-2">
            Tattoos <span className="text-slate-600 font-normal">({tattooSummary.reduce((s, t) => s + t.count, 0)})</span>
          </div>
          <div className="grid gap-1.5">
            {tattooSummary.map((t, ti) => (
              <div key={ti} className="flex items-start gap-2 py-1.5 px-2.5 rounded-lg bg-[#0a0b0e] border border-cyan-900/30">
                <span className="w-2 h-2 mt-0.5 shrink-0 rounded-sm rotate-45 bg-cyan-500" />
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-1.5">
                    <span className="text-[10px] font-bold text-cyan-300">{t.dn}</span>
                    {t.count > 1 && <span className="text-[8px] font-black text-cyan-500/50 bg-cyan-900/20 px-1.5 rounded">×{t.count}</span>}
                  </div>
                  <div className="mt-0.5">
                    {t.stats.map((s, si) => (
                      <div key={si} className="text-[8px] text-cyan-300/60 leading-snug">{s}</div>
                    ))}
                  </div>
                </div>
              </div>
            ))}
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
