#!/usr/bin/env node
/**
 * Generate a provenance-safe CellPACK/Mesoscale-style Mol View Story.
 *
 * This produces a portable MolViewSpec reconstruction, not a Mol* Mesoscale
 * Explorer plugin state. It never invents biological component names.
 */

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { inspectCellpackModel, writeSelectedAssemblyInstancesCif } from './lib/binary_cif_inspector.mjs';
import { classifyStoryInput, formatClassificationRefusal } from './lib/story_input_classifier.mjs';

const SCRIPT_FILE = fileURLToPath(import.meta.url);
const GROUP_ORDER = ['membrane', 'surface', 'interior', 'fiber', 'components', 'unassigned'];
const GROUP_TITLES = {
  membrane: 'Membrane-associated components',
  surface: 'Surface components',
  interior: 'Interior components',
  fiber: 'Fibers and extended cargo',
  components: 'Other annotated components',
  unassigned: 'Unassigned components',
};
const GROUP_PALETTES = {
  membrane: ['#7D8790', '#A8B0B7', '#5C747D'],
  surface: ['#E9B949', '#D97706', '#F2CC8F', '#3D7EA6'],
  interior: ['#2A9D8F', '#6A4C93', '#D1495B', '#4D908E', '#577590'],
  fiber: ['#3A86FF', '#00A6A6', '#8338EC'],
  components: ['#5B8E7D', '#BC4B51', '#8D6A9F', '#4F772D'],
  unassigned: ['#9AA0A6'],
};
const PATH_GROUP_TOKENS = [
  ['membrane', ['membrane', 'bilayer', 'lipid']],
  ['surface', ['surface', 'envelope', 'outer']],
  ['fiber', ['fiber', 'filament', 'dna', 'rna']],
  ['interior', ['interior', 'inside', 'lumen', 'cargo']],
];
const PERFORMANCE_PROFILES = new Set(['scientific', 'overview', 'coarse-overview', 'curated-presentation']);
const INTENDED_USE_BY_PROFILE = {
  scientific: 'interactive scientific inspection',
  overview: 'smooth laptop autoplay',
  'coarse-overview': 'smooth laptop autoplay',
  'curated-presentation': 'laptop Chrome molecular presentation',
};

function parseArgs(argv) {
  const args = { _: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const item = argv[i];
    if (!item.startsWith('--')) {
      args._.push(item);
      continue;
    }
    const raw = item.slice(2);
    const eq = raw.indexOf('=');
    const key = eq >= 0 ? raw.slice(0, eq) : raw;
    let value = eq >= 0 ? raw.slice(eq + 1) : true;
    if (value === true && argv[i + 1] && !argv[i + 1].startsWith('--')) {
      value = argv[i + 1];
      i += 1;
    }
    args[key.replace(/-([a-z])/g, (_, letter) => letter.toUpperCase())] = value;
  }
  return args;
}

function usage() {
  return `Usage:
  node scripts/server-docking-pipeline/make_cellpack_story.mjs --input <model.bcif> [options]

Options:
  --out-dir <dir>             Output directory. Default: <input-dir>/<name>_cellpack_story
  --output <story.mvsj>       Explicit MVSJ output path.
  --annotation-map <json>     Optional provenance-bearing component annotation map.
  --title <text>              Story title.
  --assembly-id <id>          Assembly to inspect and render. Default: first assembly.
  --cutaway <true|false>      Include clipped interior view. Default: true.
  --clip-axis <x|y|z>         Cutaway plane normal. Default: x.
  --clip-offset <fraction>    Plane offset as a fraction of model extent. Default: 0.
  --max-group-scenes <n>      Maximum component-group scenes after overview/cutaway. Default: 5.
  --performance-profile <scientific|overview|coarse-overview|curated-presentation>
                              Scientific keeps research-oriented detail; overview favors
                              smooth laptop autoplay; coarse-overview builds a lightweight
                              instance-center primitive proxy without loading atomistic BCIF
                              into the viewer; curated-presentation shows a small deterministic
                              subset of real CellPACK molecular instances.
  --max-proxies <n>           Maximum instance proxy spheres for coarse-overview. Default: 2400.
  --proxy-radius-scale <n>    Radius multiplier for coarse proxy spheres. Default: 0.38.
  --performance-preset <fast|balanced|quality>
                              Technical compatibility flag. If omitted, scientific maps to
                              quality and overview maps to fast.
  --coordinate-unit <coordinate|angstrom|nanometer>
                              Unit for measurement labels. Default: coordinate.
  --guide-scale <fraction>     Fraction of max-axis extent used for the visible
                              cutaway guide. Default: 0.42.
  --builtin-validate <bool>   Run deterministic built-in MVSJ checks. Default: false.
  --validate <true|false>     Deprecated alias for --builtin-validate.
  --force-cellpack <bool>     Override ordinary/ambiguous classification for a verified model.
  --help                      Show this help.

Annotation JSON may provide:
  {
    "components": [
      {
        "label_entity_id": "12",
        "label": "Explicit name",
        "group": "surface",
        "color": "#336699",
        "provenance": "annotation.json:curated-map"
      }
    ]
  }
`;
}

function requiredFile(raw, role, extension) {
  if (!raw) throw new Error(`${role} is required`);
  const resolved = path.resolve(String(raw));
  if (!fs.existsSync(resolved) || !fs.statSync(resolved).isFile()) {
    throw new Error(`${role} does not exist: ${resolved}`);
  }
  if (extension && path.extname(resolved).toLowerCase() !== extension) {
    throw new Error(`${role} must be ${extension}: ${resolved}`);
  }
  return resolved;
}

function boolValue(value, fallback) {
  if (value === undefined) return fallback;
  if (typeof value === 'boolean') return value;
  const text = String(value).trim().toLowerCase();
  if (['1', 'true', 'yes', 'on'].includes(text)) return true;
  if (['0', 'false', 'no', 'off'].includes(text)) return false;
  throw new Error(`Expected boolean value, received "${value}"`);
}

function normalizePerformanceProfile(value) {
  const raw = String(value || 'scientific').trim().toLowerCase();
  if (!PERFORMANCE_PROFILES.has(raw)) {
    throw new Error('--performance-profile must be scientific, overview, coarse-overview, or curated-presentation');
  }
  return raw;
}

function defaultPresetForProfile(profile) {
  return profile === 'overview' ? 'fast' : 'quality';
}

function defaultGroupSceneCountForProfile(profile) {
  return profile === 'overview' ? 0 : 5;
}

function defaultMaxProxiesForProfile(profile) {
  return profile === 'coarse-overview' ? 2400 : 0;
}

function numberValue(value, fallback, role) {
  if (value === undefined) return fallback;
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) throw new Error(`${role} must be numeric`);
  return parsed;
}

function safeId(value, fallback = 'component') {
  const normalized = String(value || '')
    .normalize('NFKD')
    .replace(/[^\x00-\x7F]/g, '')
    .replace(/[^A-Za-z0-9_.-]+/g, '_')
    .replace(/^[-.]+|[-.]+$/g, '')
    .slice(0, 80);
  return normalized || fallback;
}

function readAnnotationMap(rawPath) {
  if (!rawPath) return { path: null, entries: new Map(), metadata: null };
  const annotationPath = requiredFile(rawPath, 'annotation_map', '.json');
  const parsed = JSON.parse(fs.readFileSync(annotationPath, 'utf8'));
  const entries = new Map();
  const add = (id, raw, source) => {
    if (!id || !raw || typeof raw !== 'object') return;
    const provenance = String(
      raw.provenance || raw.source || parsed.provenance || parsed.source || '',
    ).trim();
    if (raw.label && !provenance) {
      throw new Error(
        `Annotation label for entity ${id} requires explicit provenance/source metadata; `
        + 'the annotation filename alone is not provenance',
      );
    }
    entries.set(String(id), {
      label: raw.label ? String(raw.label).trim() : null,
      group: raw.group ? safeGroup(raw.group) : null,
      color: raw.color ? validateColor(raw.color) : null,
      provenance: provenance || `${source}:no-visible-label`,
    });
  };
  for (const item of Array.isArray(parsed.components) ? parsed.components : []) {
    add(item.label_entity_id || item.entity_id || item.id, item, `${path.basename(annotationPath)}:components`);
  }
  for (const [id, item] of Object.entries(parsed.label_entity_id || {})) {
    add(id, typeof item === 'string' ? { label: item } : item, `${path.basename(annotationPath)}:label_entity_id`);
  }
  return { path: annotationPath, entries, metadata: parsed.metadata || null };
}

function validateColor(value) {
  const color = String(value).trim();
  if (!/^#[0-9A-Fa-f]{6}$/.test(color)) throw new Error(`Invalid annotation color: ${value}`);
  return color.toUpperCase();
}

function safeGroup(value) {
  const group = safeId(value, 'components').toLowerCase();
  return group || 'components';
}

function metadataDisplayLabel(entity) {
  if (!entity.description) return entity.label;
  const parts = entity.description.split(/[./\\]+/).map(part => part.trim()).filter(Boolean);
  return parts.at(-1) || entity.description;
}

function classifyMetadataGroup(entity) {
  const haystack = `${entity.description || ''} ${entity.details || ''}`.toLowerCase();
  for (const [group, tokens] of PATH_GROUP_TOKENS) {
    const token = tokens.find(candidate => (
      new RegExp(`(^|[._/\\s-])${escapeRegex(candidate)}([._/\\s-]|$)`, 'i').test(haystack)
    ));
    if (token) {
      return {
        group,
        source_type: 'metadata-token',
        source: 'derived from explicit BCIF metadata tokens',
        evidence: `matched token "${token}" in BinaryCIF entity metadata`,
      };
    }
  }
  if (entity.label_source === 'generated:unassigned') {
    return {
      group: 'unassigned',
      source_type: 'generated-fallback',
      source: 'generated fallback for an unnamed BinaryCIF entity',
      evidence: 'no source label or recognized grouping token was available',
    };
  }
  return {
    group: 'components',
    source_type: 'metadata-fallback',
    source: 'generic group without biological inference',
    evidence: 'no recognized grouping token was present in BinaryCIF entity metadata',
  };
}

function escapeRegex(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function enrichEntities(inspection, annotations) {
  const counters = new Map();
  return inspection.entities.map(entity => {
    const annotation = annotations.entries.get(entity.id);
    const groupInfo = annotation?.group ? {
      group: annotation.group,
      source_type: 'explicit-annotation',
      source: annotation.provenance,
      evidence: `explicit annotation group "${annotation.group}"`,
    } : classifyMetadataGroup(entity);
    const group = groupInfo.group;
    const index = counters.get(group) || 0;
    counters.set(group, index + 1);
    const palette = GROUP_PALETTES[group] || GROUP_PALETTES.components;
    const label = annotation?.label || metadataDisplayLabel(entity);
    const labelSource = annotation?.label ? annotation.provenance : entity.label_source;
    return {
      ...entity,
      label,
      label_source: labelSource,
      group,
      group_source: groupInfo.source,
      group_source_type: groupInfo.source_type,
      group_evidence: groupInfo.evidence,
      color: annotation?.color || palette[index % palette.length],
      ref: `entity_${safeId(entity.id)}_${safeId(label, 'unassigned')}`,
    };
  });
}

function lodCustom(bounds) {
  const radius = Math.max(bounds.radius || 500, 100);
  return {
    molstar_representation_params: {
      lodLevels: [
        { minDistance: 1, maxDistance: radius * 1.5, overlap: 0, stride: 1, scaleBias: 1 },
        { minDistance: radius * 1.5, maxDistance: radius * 4, overlap: 0, stride: 15, scaleBias: 3 },
        { minDistance: radius * 4, maxDistance: radius * 12, overlap: 0, stride: 70, scaleBias: 2.7 },
        { minDistance: radius * 12, maxDistance: 10000000, overlap: 0, stride: 200, scaleBias: 2.5 },
      ],
      instanceGranularity: true,
      ignoreLight: true,
      clipPrimitive: true,
    },
  };
}

function clipParams(bounds, axis, offsetFraction) {
  const index = { x: 0, y: 1, z: 2 }[axis];
  const normal = [0, 0, 0];
  normal[index] = 1;
  const point = [...bounds.center];
  point[index] += bounds.extent[index] * offsetFraction;
  return { type: 'plane', normal, point: point.map(round3), variant: 'object' };
}

function componentNode(entity, custom, clip, opacity = 1) {
  const children = [
    { kind: 'color', params: { color: entity.color } },
  ];
  if (opacity < 1) children.push({ kind: 'opacity', params: { opacity } });
  if (clip) children.push({ kind: 'clip', params: clip });
  return {
    kind: 'component',
    params: { selector: { label_entity_id: entity.id } },
    children: [{
      kind: 'representation',
      ref: entity.ref,
      params: { type: 'spacefill', ignore_hydrogens: true },
      custom,
      children,
    }],
  };
}

function contextNode(custom, clip, opacity = 0.08) {
  const children = [
    { kind: 'color', params: { color: '#B9C0C7' } },
    { kind: 'opacity', params: { opacity } },
  ];
  if (clip) children.push({ kind: 'clip', params: clip });
  return {
    kind: 'component',
    params: { selector: 'all' },
    children: [{
      kind: 'representation',
      params: { type: 'spacefill', ignore_hydrogens: true },
      custom,
      children,
    }],
  };
}

function selectorForEntities(entities) {
  const selectors = entities.map(entity => ({ label_entity_id: entity.id }));
  return selectors.length === 1 ? selectors[0] : selectors;
}

function groupComponentNode(group, custom, clip, opacity = 1) {
  const children = [
    { kind: 'color', params: { color: group.color } },
  ];
  if (opacity < 1) children.push({ kind: 'opacity', params: { opacity } });
  if (clip) children.push({ kind: 'clip', params: clip });
  return {
    kind: 'component',
    params: { selector: selectorForEntities(group.entities) },
    children: [{
      kind: 'representation',
      ref: `group_${safeId(group.name)}_representation`,
      params: { type: 'spacefill', ignore_hydrogens: true },
      custom,
      children,
    }],
  };
}

function representativeEntities(group, limit = 10) {
  return group.entities.slice(0, Math.max(1, limit));
}

function representativeNodes(groups, custom, clip, perGroupLimit = 10, opacity = 1) {
  return groups.flatMap(group => representativeEntities(group, perGroupLimit)
    .map(entity => componentNode(entity, custom, clip, opacity)));
}

function storyRoot(assetName, assemblyId, componentChildren, focus, background = '#F4F6F8', extraRootChildren = []) {
  return {
    kind: 'root',
    children: [
      { kind: 'canvas', params: { background_color: background } },
      {
        kind: 'download',
        params: { url: assetName },
        children: [{
          kind: 'parse',
          params: { format: 'bcif' },
          children: [{
            kind: 'structure',
            ref: 'cellpack_structure',
            params: { type: 'assembly', assembly_id: assemblyId || null },
            children: componentChildren,
          }],
        }],
      },
      ...extraRootChildren,
      { kind: 'focus', params: focus },
    ],
  };
}

function modelStoryRoot(assetName, componentChildren, focus, background = '#F4F6F8', format = 'mmcif', extraRootChildren = []) {
  return {
    kind: 'root',
    children: [
      { kind: 'canvas', params: { background_color: background } },
      {
        kind: 'download',
        params: { url: assetName },
        children: [{
          kind: 'parse',
          params: { format },
          children: [{
            kind: 'structure',
            ref: 'curated_cellpack_selection',
            params: { type: 'model' },
            children: componentChildren,
          }],
        }],
      },
      ...extraRootChildren,
      { kind: 'focus', params: focus },
    ],
  };
}

function focusFor(bounds, direction = [0.8, 0.35, 1], radiusScale = null) {
  const length = Math.hypot(...direction);
  const unit = direction.map(value => value / length);
  const maxExtent = Math.max(...bounds.extent);
  const largeModel = maxExtent >= 1000 || bounds.radius >= 750;
  const radiusFactor = radiusScale ?? (largeModel ? 0.72 : 0.86);
  return {
    direction: unit.map(value => round3(-value)),
    up: [0, 1, 0],
    radius: round3(bounds.radius * radiusFactor),
  };
}

function snapshot(key, title, description, root) {
  return {
    root,
    metadata: {
      key,
      title,
      description,
      description_format: 'markdown',
      linger_duration_ms: 7000,
      transition_duration_ms: 1200,
    },
  };
}

function groupLinks(groups) {
  return groups.map(group => {
    const refs = group.entities.map(entity => entity.ref).join(',');
    return `- [${group.title}](!highlight-refs=${refs}&focus-refs=${refs})`
      + ` (\`${group.name}\`, ${group.entity_count} entity type${group.entity_count === 1 ? '' : 's'}; ${group.story_evidence})`;
  }).join('\n');
}

function entityLinks(entities) {
  return entities.map(entity => (
    `- [${escapeMarkdown(entity.label)}](!highlight-refs=${entity.ref}&focus-refs=${entity.ref})`
    + ` - entity \`${entity.id}\`; label source: \`${escapeMarkdown(entity.label_source)}\``
  )).join('\n');
}

function escapeMarkdown(value) {
  return String(value).replaceAll('[', '\\[').replaceAll(']', '\\]');
}

function measurementLabel(value, coordinateUnit) {
  if (coordinateUnit === 'angstrom') {
    return `${round3(value)} Å`;
  }
  if (coordinateUnit === 'nanometer') return `≈ ${round3(value)} nm`;
  return `${round3(value)} coordinate units`;
}

function coordinateGeometry(bounds, coordinateUnit = 'coordinate', guideScale = 0.42) {
  const extent = bounds.extent.map(round3);
  const maxAxisIndex = extent.indexOf(Math.max(...extent));
  const axis = ['x', 'y', 'z'][maxAxisIndex];
  const scale = Math.max(0.05, Math.min(1, guideScale));
  const start = bounds.center.map((value, index) => (
    index === maxAxisIndex ? round3(value - (bounds.extent[index] * scale) / 2) : round3(value)
  ));
  const end = bounds.center.map((value, index) => (
    index === maxAxisIndex ? round3(value + (bounds.extent[index] * scale) / 2) : round3(value)
  ));
  const guideValue = round3(Math.max(...extent) * scale);
  return {
    extent_x: extent[0],
    extent_y: extent[1],
    extent_z: extent[2],
    max_axis_extent: round3(Math.max(...extent)),
    guide_extent: guideValue,
    max_axis: axis,
    diameter_proxy_start: start,
    diameter_proxy_end: end,
    bounding_box_diagonal: round3(Math.hypot(...extent)),
    guide_label: measurementLabel(guideValue, coordinateUnit),
    guide_scale: scale,
    unit_policy: coordinateUnit === 'coordinate'
      ? 'Report source Cartesian values as coordinate units unless physical units are explicitly supplied by the caller.'
      : `Measurement labels use caller-supplied coordinate unit: ${coordinateUnit}.`,
    physical_unit_claimed: coordinateUnit !== 'coordinate',
    physical_unit: coordinateUnit === 'coordinate' ? null : coordinateUnit,
    physical_unit_source: coordinateUnit === 'coordinate' ? null : '--coordinate-unit caller option',
  };
}

function geometryMarkdown(geometry) {
  return [
    '## Coordinate geometry',
    '',
    `- Coordinate extent: ${geometry.extent_x} x ${geometry.extent_y} x ${geometry.extent_z} coordinate units`,
    `- Max-axis extent: ${geometry.max_axis_extent} coordinate units along ${geometry.max_axis.toUpperCase()}`,
    `- Visible guide measurement: ${geometry.guide_label}`,
    `- Bounding-box diagonal: ${geometry.bounding_box_diagonal} coordinate units`,
    '- Physical units not specified in source metadata.',
  ].join('\n');
}

function diameterGuideNodes(geometry) {
  const maxExtent = Math.max(geometry.max_axis_extent, 1);
  const radius = round3(Math.max(0.28, Math.min(3.2, maxExtent * 0.0016)));
  const dashLength = round3(Math.max(5, Math.min(24, maxExtent * 0.01)));
  const labelSize = round3(Math.max(34, Math.min(80, maxExtent * 0.035)));
  return [{
    kind: 'primitives',
    ref: 'diameter_proxy_guide',
    params: {
      opacity: 0.95,
      color: '#111827',
      label_color: '#111827',
      label_attachment: 'middle-center',
    },
    children: [
      {
        kind: 'primitive',
        params: {
          kind: 'distance_measurement',
          start: geometry.diameter_proxy_start,
          end: geometry.diameter_proxy_end,
          radius,
          dash_length: dashLength,
          color: '#111827',
          label_template: geometry.guide_label,
          label_color: '#111827',
          label_size: labelSize,
        },
      },
    ],
  }];
}

function hashUnit(value) {
  const digest = crypto.createHash('sha1').update(String(value)).digest();
  return digest.readUInt32BE(0) / 0xffffffff;
}

function attachProxyMetadata(inspection, entities, maxProxies, radiusScale) {
  const entityById = new Map(entities.map(entity => [entity.id, entity]));
  const raw = Array.isArray(inspection.instance_proxies) ? inspection.instance_proxies : [];
  const bounds = inspection.assembly_bounds || inspection.source_bounds;
  const maxExtent = Math.max(...bounds.extent, 1);
  const minRadius = Math.max(4, maxExtent * 0.0025);
  const maxRadius = Math.max(minRadius, maxExtent * 0.014);
  const proxies = raw
    .map((proxy) => {
      const entity = entityById.get(String(proxy.entity_id || ''));
      if (!entity || !proxy.center) return null;
      const sourceRadius = Number(proxy.radius || entity.bounds?.radius || minRadius);
      return {
        ...proxy,
        entity,
        group: entity.group,
        color: entity.color,
        ref: `proxy_${safeId(proxy.instance_key, 'instance')}`,
        radius: round3(Math.max(minRadius, Math.min(maxRadius, sourceRadius * radiusScale))),
        hash: hashUnit(proxy.instance_key),
      };
    })
    .filter(Boolean);
  if (proxies.length <= maxProxies) return proxies.sort((a, b) => a.hash - b.hash);

  const byGroup = new Map();
  for (const proxy of proxies) {
    if (!byGroup.has(proxy.group)) byGroup.set(proxy.group, []);
    byGroup.get(proxy.group).push(proxy);
  }
  const selected = [];
  const total = proxies.length;
  for (const groupProxies of byGroup.values()) {
    groupProxies.sort((a, b) => a.hash - b.hash);
    const target = Math.max(8, Math.round(maxProxies * (groupProxies.length / total)));
    const count = Math.min(target, groupProxies.length);
    const step = groupProxies.length / count;
    for (let i = 0; i < count; i += 1) {
      selected.push(groupProxies[Math.min(groupProxies.length - 1, Math.floor((i + 0.5) * step))]);
    }
  }
  return selected.sort((a, b) => a.hash - b.hash).slice(0, maxProxies);
}

function proxyPrimitiveGroup(groupName, proxies, opacity = 1) {
  const groupColor = GROUP_PALETTES[groupName]?.[0] || proxies[0]?.color || '#9AA0A6';
  return {
    kind: 'primitives',
    ref: `coarse_proxy_${safeId(groupName)}`,
    params: {
      opacity,
      color: groupColor,
      tooltip: `${groupName} instance-center proxy`,
    },
    children: proxies.map(proxy => ({
      kind: 'primitive',
      params: {
        kind: 'ellipsoid',
        center: proxy.center,
        major_axis: [1, 0, 0],
        minor_axis: [0, 1, 0],
        radius: [proxy.radius, proxy.radius, proxy.radius],
        color: proxy.color,
        tooltip: `${proxy.entity.label}; entity ${proxy.entity.id}; instance ${proxy.instance_key}`,
      },
    })),
  };
}

function proxyLabelNodes(groups, proxiesByGroup, bounds) {
  const maxExtent = Math.max(...bounds.extent, 1);
  const labelSize = round3(Math.max(26, Math.min(58, maxExtent * 0.012)));
  return groups
    .filter(group => proxiesByGroup.has(group.name))
    .slice(0, 6)
    .map((group) => {
      const members = proxiesByGroup.get(group.name);
      const center = [0, 1, 2].map(index => round3(
        members.reduce((sum, proxy) => sum + proxy.center[index], 0) / members.length,
      ));
      return {
        kind: 'primitives',
        ref: `coarse_label_${safeId(group.name)}`,
        params: {
          label_color: '#111827',
          label_background_color: '#F8FAFC',
          label_attachment: 'middle-center',
          label_show_tether: false,
        },
        children: [{
          kind: 'primitive',
          params: {
            kind: 'label',
            position: center,
            text: group.title,
            label_size: labelSize,
          },
        }],
      };
    });
}

function proxyGroupsByName(proxies) {
  const result = new Map();
  for (const proxy of proxies) {
    if (!result.has(proxy.group)) result.set(proxy.group, []);
    result.get(proxy.group).push(proxy);
  }
  return result;
}

function proxyPrimitiveNodes(proxies, opacity = 1) {
  return [...proxyGroupsByName(proxies).entries()].map(([groupName, members]) => (
    proxyPrimitiveGroup(groupName, members, opacity)
  ));
}

function primitiveRoot(bounds, primitiveChildren, focus, background = '#EEF2F5') {
  return {
    kind: 'root',
    children: [
      { kind: 'canvas', params: { background_color: background } },
      ...primitiveChildren,
      { kind: 'focus', params: focus },
    ],
  };
}

function cinematicSnapshot(key, title, description, root) {
  const item = snapshot(key, title, description, root);
  item.metadata.linger_duration_ms = 5200;
  item.metadata.transition_duration_ms = 2200;
  return item;
}

function distance3(a, b) {
  return Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
}

function instanceSelector(proxy) {
  if (proxy.curated_asym_id) return { label_asym_id: proxy.curated_asym_id };
  const selector = { label_asym_id: proxy.label_asym_id };
  const instanceId = Array.isArray(proxy.operation_ids) && proxy.operation_ids.length
    ? proxy.operation_ids.join('*')
    : null;
  if (instanceId) selector.instance_id = instanceId;
  return selector;
}

function instanceRef(proxy) {
  return `${proxy.label_asym_id}:${(proxy.operation_ids || []).join('*') || 'identity'}`;
}

function enrichedInstanceProxies(inspection, entities) {
  const entityById = new Map(entities.map(entity => [entity.id, entity]));
  const bounds = inspection.assembly_bounds || inspection.source_bounds;
  const center = bounds.center;
  return (inspection.instance_proxies || [])
    .map((proxy) => {
      const entity = entityById.get(String(proxy.entity_id || ''));
      if (!entity || !proxy.center) return null;
      return {
        ...proxy,
        entity,
        group: entity.group,
        color: entity.color,
        source_atom_count: Number(proxy.source_atom_count || 0),
        distance_from_center: round3(distance3(proxy.center, center)),
        normalized_radius: bounds.radius ? round3(distance3(proxy.center, center) / bounds.radius) : null,
      };
    })
    .filter(Boolean);
}

function candidateCategories(entities) {
  const byGroup = new Map();
  for (const entity of entities) {
    if (!byGroup.has(entity.group)) byGroup.set(entity.group, []);
    byGroup.get(entity.group).push(entity);
  }
  return [...byGroup.entries()]
    .sort((a, b) => {
      const ai = GROUP_ORDER.indexOf(a[0]);
      const bi = GROUP_ORDER.indexOf(b[0]);
      return (ai < 0 ? 999 : ai) - (bi < 0 ? 999 : bi) || a[0].localeCompare(b[0]);
    })
    .map(([group, members]) => {
      const sorted = [...members].sort((a, b) => (b.instance_count || 0) - (a.instance_count || 0));
      const sourceAtomCount = members.reduce((sum, entity) => sum + Number(entity.source_atom_count || 0), 0);
      return {
        group,
        identifier: group,
        source_name_or_label: GROUP_TITLES[group] || group,
        biological_annotation_source: 'BCIF entity.pdbx_description/details token grouping',
        entity_count: members.length,
        number_of_instances: members.reduce((sum, entity) => sum + Number(entity.instance_count || 0), 0),
        source_atom_count: sourceAtomCount,
        estimated_full_assembly_atom_load: Math.round(members.reduce((sum, entity) => {
          const perAsym = Number(entity.source_atom_count || 0) / Math.max(1, Number(entity.asym_count || 1));
          return sum + perAsym * Number(entity.instance_count || 0);
        }, 0)),
        spatial_localization: group === 'surface' || group === 'membrane'
          ? 'outer/surface-associated by explicit metadata token'
          : group === 'interior'
            ? 'internal by explicit metadata token'
            : group === 'fiber'
              ? 'fiber/nucleic-acid-like by explicit metadata token'
              : 'not localized by recognized metadata token',
        cinematic_suitability: group === 'unassigned'
          ? 'not suitable without explicit annotation'
          : 'suitable as a curated subset only; full group is too heavy for laptop autoplay',
        top_entities: sorted.slice(0, 12).map(entity => ({
          entity_id: entity.id,
          label: entity.label,
          label_source: entity.label_source,
          group_evidence: entity.group_evidence,
          asym_count: entity.asym_count,
          source_atom_count: entity.source_atom_count || 0,
          instance_count: entity.instance_count || 0,
        })),
      };
    });
}

function chooseTopEntities(entities, predicate, limit) {
  return entities
    .filter(predicate)
    .sort((a, b) => (b.instance_count || 0) - (a.instance_count || 0) || String(a.id).localeCompare(String(b.id)))
    .slice(0, limit);
}

function deterministicSpread(items, limit, sorter) {
  const sorted = [...items].sort(sorter);
  const count = Math.min(limit, sorted.length);
  if (count <= 0) return [];
  if (count === sorted.length) return sorted;
  if (count === 1) return [sorted[Math.floor(sorted.length / 2)]];
  const selected = [];
  const used = new Set();
  for (let i = 0; i < count; i += 1) {
    const index = Math.round((i * (sorted.length - 1)) / (count - 1));
    const item = sorted[index];
    const key = item.instance_key;
    if (!used.has(key)) {
      selected.push(item);
      used.add(key);
    }
  }
  return selected;
}

function spatialSelectorForRule(rule, bounds) {
  const center = bounds.center;
  if (rule === 'outer-shell-evenly-distributed') {
    return (a, b) => {
      const da = distance3(a.center, center);
      const db = distance3(b.center, center);
      const aa = Math.atan2(a.center[1] - center[1], a.center[0] - center[0]);
      const ab = Math.atan2(b.center[1] - center[1], b.center[0] - center[0]);
      return aa - ab || b.center[2] - a.center[2] || db - da || a.instance_key.localeCompare(b.instance_key);
    };
  }
  if (rule === 'central-evenly-distributed') {
    return (a, b) => (
      distance3(a.center, center) - distance3(b.center, center)
      || a.instance_key.localeCompare(b.instance_key)
    );
  }
  if (rule === 'axis-quantile') {
    return (a, b) => (
      a.center[2] - b.center[2]
      || Math.atan2(a.center[1] - center[1], a.center[0] - center[0])
        - Math.atan2(b.center[1] - center[1], b.center[0] - center[0])
      || a.instance_key.localeCompare(b.instance_key)
    );
  }
  return (a, b) => a.instance_key.localeCompare(b.instance_key);
}

function selectCuratedInstances({ inspection, entities }) {
  const bounds = inspection.assembly_bounds || inspection.source_bounds;
  const proxies = enrichedInstanceProxies(inspection, entities);
  if (!proxies.length) {
    throw new Error('curated-presentation requires assembly instance metadata; no instance table could be derived from the BCIF');
  }
  const byEntity = new Map();
  for (const proxy of proxies) {
    if (!byEntity.has(proxy.entity.id)) byEntity.set(proxy.entity.id, []);
    byEntity.get(proxy.entity.id).push(proxy);
  }
  const label = entity => String(entity.label || entity.description || '').toLowerCase();
  const surfaceEntities = chooseTopEntities(entities, entity => ['membrane', 'surface'].includes(entity.group), 5);
  const fiberEntities = chooseTopEntities(entities, entity => (
    entity.group === 'fiber'
    && /(dna|rna|trna)/i.test(label(entity))
    && !/(polymerase|gyrase)/i.test(label(entity))
  ), 3);
  const machineryEntities = chooseTopEntities(entities, entity => (
    /(ribosome|polymerase|gyrase)/i.test(label(entity))
  ), 5);
  const interiorEntities = chooseTopEntities(entities, entity => (
    entity.group === 'interior' && !/(ribosome|polymerase|gyrase)/i.test(label(entity))
  ), 6);

  const specs = [
    {
      name: surfaceEntities.some(entity => entity.group === 'membrane') ? 'membrane_context' : 'surface_context',
      title: surfaceEntities.some(entity => entity.group === 'membrane') ? 'Membrane-associated context' : 'Surface context',
      source_group: surfaceEntities.some(entity => entity.group === 'membrane') ? 'membrane' : 'surface',
      entities: surfaceEntities,
      max_instances: 8,
      selection_rule: 'outer-shell-evenly-distributed',
      reason: 'Outer/surface-associated components are the closest metadata-supported substitute for intact cell context in this BCIF.',
      color: '#6B7280',
      opacity: 0.82,
    },
    {
      name: 'nucleic_acid_fibers',
      title: 'DNA/RNA fibers',
      source_group: 'fiber',
      entities: fiberEntities,
      max_instances: 6,
      selection_rule: 'axis-quantile',
      reason: 'Entities explicitly labelled DNA/RNA in BCIF metadata provide a real internal fiber-like narrative element.',
      color: '#2F80ED',
      opacity: 1,
    },
    {
      name: 'internal_machinery',
      title: 'Internal molecular machinery',
      source_group: 'interior/fiber',
      entities: machineryEntities,
      max_instances: 3,
      selection_rule: 'central-evenly-distributed',
      reason: 'Ribosome/polymerase/gyrase labels are explicit BCIF metadata and represent recognizable internal machinery without rendering all instances.',
      color: '#F2994A',
      opacity: 1,
    },
    {
      name: 'abundant_internal_components',
      title: 'Abundant internal components',
      source_group: 'interior',
      entities: interiorEntities,
      max_instances: 4,
      selection_rule: 'central-evenly-distributed',
      reason: 'A bounded deterministic subset of abundant interior components keeps internal organization visible without full-cell rendering.',
      color: '#27AE60',
      opacity: 1,
    },
  ];

  const selectedGroups = specs.map((spec) => {
    const entityIds = new Set(spec.entities.map(entity => entity.id));
    let candidates = proxies.filter(proxy => entityIds.has(proxy.entity.id));
    if (spec.selection_rule === 'outer-shell-evenly-distributed') {
      const sortedByRadius = [...candidates].sort((a, b) => b.distance_from_center - a.distance_from_center);
      candidates = sortedByRadius.slice(0, Math.max(spec.max_instances * 4, Math.ceil(sortedByRadius.length * 0.25)));
    }
    if (spec.selection_rule === 'central-evenly-distributed') {
      const sortedByRadius = [...candidates].sort((a, b) => a.distance_from_center - b.distance_from_center);
      candidates = sortedByRadius.slice(0, Math.max(spec.max_instances * 5, Math.ceil(sortedByRadius.length * 0.2)));
    }
    const selected = deterministicSpread(candidates, spec.max_instances, spatialSelectorForRule(spec.selection_rule, bounds));
    return {
      ...spec,
      entities: spec.entities.map(entity => ({
        entity_id: entity.id,
        label: entity.label,
        label_source: entity.label_source,
        group: entity.group,
        group_evidence: entity.group_evidence,
        instance_count: entity.instance_count,
        source_atom_count: entity.source_atom_count || 0,
      })),
      selected_instances: selected.map(proxy => ({
        source_entity: proxy.entity.id,
        source_label: proxy.entity.label,
        label_source: proxy.entity.label_source,
        source_instance_id: instanceRef(proxy),
        label_asym_id: proxy.label_asym_id,
        instance_id: (proxy.operation_ids || []).join('*') || null,
        center: proxy.center,
        radius: proxy.radius,
        source_atom_count: proxy.source_atom_count,
        selection_reason: spec.reason,
        group_label: spec.title,
      })),
      selected_proxy_objects: selected,
      selected_instance_count: selected.length,
      selected_atom_count: selected.reduce((sum, proxy) => sum + Number(proxy.source_atom_count || 0), 0),
      representation: {
        type: 'spacefill',
        ignore_hydrogens: true,
        rationale: 'Real molecular geometry with a bounded number of selected assembly instances; no generic proxy primitives.',
      },
    };
  }).filter(group => group.selected_instances.length > 0);

  if (!selectedGroups.length) {
    throw new Error('No provenance-safe curated groups could be selected automatically; provide explicit annotations/selection config before generating a presentation story.');
  }

  let curatedIndex = 1;
  for (const group of selectedGroups) {
    for (let i = 0; i < group.selected_proxy_objects.length; i += 1) {
      const curatedAsymId = `CP${String(curatedIndex).padStart(4, '0')}`;
      group.selected_proxy_objects[i].curated_asym_id = curatedAsymId;
      group.selected_instances[i].curated_label_asym_id = curatedAsymId;
      curatedIndex += 1;
    }
  }

  const report = {
    source_bcif: inspection.input_file || null,
    selection_mode: 'curated-presentation',
    deterministic_selection: true,
    random_sampling: false,
    generic_proxy_geometry: false,
    all_available_candidate_categories: candidateCategories(entities),
    included_groups: selectedGroups.map(({ selected_proxy_objects: _omitted, ...group }) => group),
    excluded_category_policy: 'Unassigned or unsupported metadata categories are not labelled or selected automatically. Full categories are not rendered because this profile is a curated presentation, not full atomistic inspection.',
    deterministic_rules: selectedGroups.map(group => ({
      group: group.name,
      rule: group.selection_rule,
      max_instances: group.max_instances,
      reason: group.reason,
    })),
    total_selected_instance_count: selectedGroups.reduce((sum, group) => sum + group.selected_instance_count, 0),
    total_selected_atom_count: selectedGroups.reduce((sum, group) => sum + group.selected_atom_count, 0),
  };
  return { selectedGroups, selectionReport: report };
}

function localEmptyBounds() {
  return {
    min: [Infinity, Infinity, Infinity],
    max: [-Infinity, -Infinity, -Infinity],
  };
}

function localIncludePoint(bounds, point) {
  for (let i = 0; i < 3; i += 1) {
    bounds.min[i] = Math.min(bounds.min[i], point[i]);
    bounds.max[i] = Math.max(bounds.max[i], point[i]);
  }
}

function localFinishBounds(bounds) {
  if (!bounds || bounds.min.some(value => !Number.isFinite(value)) || bounds.max.some(value => !Number.isFinite(value))) {
    return null;
  }
  const center = [0, 1, 2].map(index => (bounds.min[index] + bounds.max[index]) / 2);
  const extent = [0, 1, 2].map(index => bounds.max[index] - bounds.min[index]);
  return {
    min: bounds.min.map(round3),
    max: bounds.max.map(round3),
    center: center.map(round3),
    extent: extent.map(round3),
    radius: round3(Math.hypot(...extent) / 2),
  };
}

function boundsFromInstances(instances, fallbackBounds) {
  const bounds = localEmptyBounds();
  for (const proxy of instances) {
    const radius = Number(proxy.radius || 0);
    localIncludePoint(bounds, [proxy.center[0] - radius, proxy.center[1], proxy.center[2]]);
    localIncludePoint(bounds, [proxy.center[0] + radius, proxy.center[1], proxy.center[2]]);
    localIncludePoint(bounds, [proxy.center[0], proxy.center[1] - radius, proxy.center[2]]);
    localIncludePoint(bounds, [proxy.center[0], proxy.center[1] + radius, proxy.center[2]]);
    localIncludePoint(bounds, [proxy.center[0], proxy.center[1], proxy.center[2] - radius]);
    localIncludePoint(bounds, [proxy.center[0], proxy.center[1], proxy.center[2] + radius]);
  }
  return localFinishBounds(bounds) || fallbackBounds;
}

function curatedComponentNode(group, custom, clip, opacity = null) {
  const selectors = group.selected_proxy_objects.map(instanceSelector);
  const children = [
    { kind: 'color', params: { color: group.color } },
  ];
  const effectiveOpacity = opacity ?? group.opacity ?? 1;
  if (effectiveOpacity < 1) children.push({ kind: 'opacity', params: { opacity: effectiveOpacity } });
  if (clip) children.push({ kind: 'clip', params: clip });
  return {
    kind: 'component',
    params: { selector: selectors.length === 1 ? selectors[0] : selectors },
    children: [{
      kind: 'representation',
      ref: `curated_${safeId(group.name)}_representation`,
      params: { type: group.representation.type, ignore_hydrogens: true },
      custom,
      children,
    }],
  };
}

function curatedMarkdownSummary(selectedGroups) {
  return selectedGroups.map(group => (
    `- ${group.title}: ${group.selected_instance_count} selected real instances; `
    + `source group \`${group.source_group}\`; rule \`${group.selection_rule}\`; atoms represented: ${group.selected_atom_count}`
  )).join('\n');
}

function buildCuratedStory({ assetName, inspection, entities, title, cutaway, axis, offset, performanceProfile, intendedUse }) {
  const bounds = inspection.assembly_bounds || inspection.source_bounds;
  if (!bounds) throw new Error('Could not calculate model bounds');
  const custom = lodCustom(bounds);
  const clip = cutaway ? clipParams(bounds, axis, offset) : null;
  const { selectedGroups, selectionReport } = selectCuratedInstances({ inspection, entities });
  const surfaceGroup = selectedGroups.find(group => group.name.includes('surface') || group.name.includes('membrane'));
  const focusGroup = selectedGroups.find(group => group.name === 'internal_machinery')
    || selectedGroups.find(group => group.name === 'nucleic_acid_fibers')
    || selectedGroups[0];
  const focusBounds = boundsFromInstances(focusGroup.selected_proxy_objects, bounds);
  const summary = curatedMarkdownSummary(selectedGroups);
  const scopeText = 'This is a curated subset of real CellPACK molecular instances, not a complete atomistic cell and not a proxy-sphere overview. Component names come from BCIF metadata only.';
  const allNodes = (sceneClip = null) => selectedGroups.map(group => curatedComponentNode(group, custom, sceneClip));
  const contextNodes = (sceneClip = null) => [
    ...(surfaceGroup ? [curatedComponentNode(surfaceGroup, custom, sceneClip, sceneClip ? 0.58 : surfaceGroup.opacity)] : []),
    ...selectedGroups.filter(group => group !== surfaceGroup).map(group => curatedComponentNode(group, custom, sceneClip)),
  ];
  const snapshots = [
    cinematicSnapshot(
      'curated_whole_cell_context',
      'Curated whole-cell context',
      `# ${escapeMarkdown(title)}\n\n${scopeText}\n\nSelected groups:\n${summary}`,
      modelStoryRoot(
        assetName,
        contextNodes(null),
        focusFor(bounds, [0.85, 0.28, 1], 0.62),
        '#F3F5F7',
      ),
    ),
  ];

  if (cutaway && clip) {
    snapshots.push(cinematicSnapshot(
      'curated_cutaway',
      'Curated cutaway',
      `# Cutaway\n\nA single clipping plane reveals selected real internal instances while keeping the metadata-supported surface context legible.\n\n${scopeText}`,
      modelStoryRoot(
        assetName,
        contextNodes(clip),
        focusFor(bounds, [1, 0.22, 0.82], 0.54),
        '#EEF1F4',
      ),
    ));
  }

  snapshots.push(cinematicSnapshot(
    'curated_focus',
    focusGroup.title,
    `# ${escapeMarkdown(focusGroup.title)}\n\n${focusGroup.reason}\n\nVisible selection: ${focusGroup.selected_instance_count} real instances, ${focusGroup.selected_atom_count} source atoms represented. Labels are from BCIF metadata, not biological inference.`,
    modelStoryRoot(
      assetName,
      [
        ...(surfaceGroup && surfaceGroup !== focusGroup ? [curatedComponentNode(surfaceGroup, custom, clip, 0.22)] : []),
        curatedComponentNode(focusGroup, custom, clip, 1),
      ],
      focusFor(focusBounds, [0.78, 0.36, 1], 0.92),
      '#F6F7F9',
    ),
  ));

  snapshots.push(cinematicSnapshot(
    'curated_final_overview',
    'Final composed overview',
    `# Final overview\n\nThe composed presentation keeps only the curated real molecular subset for laptop playback.\n\n${summary}`,
    modelStoryRoot(
      assetName,
      allNodes(clip),
      focusFor(bounds, [0.72, 0.38, 1], 0.58),
      '#F1F4F6',
    ),
  ));

  return {
    story: {
      kind: 'multiple',
      metadata: {
        title,
        description: 'Curated CellPACK molecular presentation generated from BinaryCIF metadata and selected real assembly instances.',
        description_format: 'markdown',
        timestamp: new Date().toISOString(),
        version: '1',
        performanceProfile,
        intendedUse,
        scientificScope: 'Curated subset of real CellPACK molecular instances; not a complete atomistic cell.',
      },
      snapshots,
    },
    selection_report: selectionReport,
    curated_policy: {
      performanceProfile,
      intendedUse,
      scientificScope: 'Curated subset of real CellPACK molecular instances; not a complete atomistic cell.',
      selected_group_count: selectedGroups.length,
      selected_instance_count: selectionReport.total_selected_instance_count,
      selected_atom_count: selectionReport.total_selected_atom_count,
      random_sampling: false,
      generic_proxy_geometry: false,
      full_cell_atomistic_rendering: false,
      selection_rule: 'metadata-filtered deterministic spatial representatives from actual BCIF assembly instances',
    },
    selected_groups: selectedGroups.map(({ selected_proxy_objects: _omitted, ...group }) => group),
    selected_instances_for_extraction: selectedGroups.flatMap(group => group.selected_proxy_objects.map(proxy => ({
      label_asym_id: proxy.label_asym_id,
      operation_ids: proxy.operation_ids || [],
      output_label_asym_id: proxy.curated_asym_id,
      source_entity: proxy.entity.id,
      source_label: proxy.entity.label,
      group_label: group.title,
    }))),
  };
}

function buildCoarseStory({ inputPath, inspection, entities, title, cutaway, axis, offset, maxProxies, proxyRadiusScale, performanceProfile, intendedUse, coordinateUnit, guideScale }) {
  const bounds = inspection.assembly_bounds || inspection.source_bounds;
  if (!bounds) throw new Error('Could not calculate model bounds');
  const geometry = coordinateGeometry(bounds, coordinateUnit, guideScale);
  const grouped = new Map();
  for (const entity of entities) {
    if (!grouped.has(entity.group)) grouped.set(entity.group, []);
    grouped.get(entity.group).push(entity);
  }
  const orderedGroups = [...grouped.entries()].sort((a, b) => {
    const ai = GROUP_ORDER.indexOf(a[0]);
    const bi = GROUP_ORDER.indexOf(b[0]);
    return (ai < 0 ? 999 : ai) - (bi < 0 ? 999 : bi) || a[0].localeCompare(b[0]);
  });
  const groups = groupSummaries(orderedGroups);
  const proxies = attachProxyMetadata(inspection, entities, maxProxies, proxyRadiusScale);
  const axisIndex = { x: 0, y: 1, z: 2 }[axis];
  const clipPoint = bounds.center[axisIndex] + bounds.extent[axisIndex] * offset;
  const cutawayProxies = cutaway
    ? proxies.filter(proxy => proxy.center[axisIndex] >= clipPoint)
    : proxies;
  const proxyGroupMap = proxyGroupsByName(proxies);
  const proxySummary = `This coarse-overview story uses ${proxies.length} sampled instance-center proxy spheres from ${inspection.total_instance_count} assembly instances. It does not load the atomistic BCIF into the viewer.`;
  const provenanceText = 'Proxy positions are derived deterministically from BCIF assembly transforms and entity bounds. Labels and group names use BCIF metadata or explicit annotations only.';
  const legendText = groupLegendMarkdown(groups);
  const geometryText = geometryMarkdown(geometry);
  const snapshots = [
    cinematicSnapshot(
      'coarse_exterior',
      'Coarse exterior proxy',
      `# ${escapeMarkdown(title)}\n\n${proxySummary}\n\n${geometryText}\n\n${legendText}\n\n${provenanceText}`,
      primitiveRoot(
        bounds,
        [
          ...proxyPrimitiveNodes(proxies, 0.98),
          ...proxyLabelNodes(groups, proxyGroupMap, bounds),
        ],
        focusFor(bounds, [0.85, 0.45, 1], 0.64),
      ),
    ),
  ];
  if (cutaway) {
    snapshots.push(cinematicSnapshot(
      'coarse_cutaway',
      'Coarse cutaway proxy',
      `# Coarse cutaway proxy\n\n${proxySummary}\n\nHalf of the sampled proxy instances are hidden by coordinate threshold to expose internal organization. This is a performance-oriented proxy, not an atomistic cutaway.\n\n${geometryText}\n\n${provenanceText}`,
      primitiveRoot(
        bounds,
        [
          ...proxyPrimitiveNodes(cutawayProxies, 0.98),
          ...diameterGuideNodes(geometry),
        ],
        focusFor(bounds, [1, 0.25, 0.85], 0.48),
      ),
    ));
  }
  snapshots.push(cinematicSnapshot(
    'coarse_interior_orbit',
    'Interior organization proxy',
    `# Interior organization proxy\n\n${cutaway ? 'Cutaway proxy view' : 'Proxy view'} for smooth playback. Use the scientific profile when atomistic inspection is needed.\n\n${provenanceText}`,
    primitiveRoot(
      bounds,
      proxyPrimitiveNodes(cutaway ? cutawayProxies : proxies, 0.9),
      focusFor(bounds, [-0.7, 0.4, 1], 0.44),
      '#F5F7FA',
    ),
  ));
  return {
    story: {
      kind: 'multiple',
      metadata: {
        title,
        description: 'Coarse CellPACK/Mesoscale proxy story generated from BinaryCIF instance metadata.',
        description_format: 'markdown',
        timestamp: new Date().toISOString(),
        version: '1',
        performanceProfile,
        intendedUse,
        proxyKind: 'sampled instance-center primitive spheres',
        sourceModel: path.basename(inputPath),
      },
      snapshots,
    },
    proxies,
    groups,
    geometry,
    proxy_policy: {
      proxy_kind: 'sampled instance-center primitive spheres',
      source: 'BinaryCIF assembly operations plus per-asym bounds',
      atomistic_model_loaded_in_viewer: false,
      max_proxies: maxProxies,
      selected_proxy_count: proxies.length,
      raw_instance_count: inspection.total_instance_count,
      radius_scale: proxyRadiusScale,
      sampling_strategy: 'deterministic stratified hash sample by metadata group',
      scientific_semantics_changed: true,
      intended_use: intendedUse,
    },
  };
}

function manifestInspection(inspection) {
  const { instance_proxies: _instanceProxies, ...safeInspection } = inspection;
  return {
    ...safeInspection,
    derived_instance_table: _instanceProxies ? {
      generated_for_profiles: ['coarse-overview', 'curated-presentation'],
      raw_instance_count: _instanceProxies.length,
      omitted_from_manifest: true,
      reason: 'Avoid storing large derived per-instance tables in run metadata.',
    } : null,
  };
}

function groupSummaries(orderedGroups) {
  return orderedGroups.map(([name, entities]) => {
    const sourceTypes = [...new Set(entities.map(entity => entity.group_source_type))].sort();
    const sources = [...new Set(entities.map(entity => entity.group_source))].sort();
    const evidence = [...new Set(entities.map(entity => entity.group_evidence))].sort();
    const metadataTokens = [...new Set(evidence.flatMap(item => {
      const match = /^matched token "([^"]+)"/.exec(item);
      return match ? [match[1]] : [];
    }))].sort();
    const sourceType = sourceTypes.length === 1 ? sourceTypes[0] : 'mixed';
    let storyEvidence;
    if (sourceType === 'metadata-token') {
      storyEvidence = `grouping from BCIF metadata token${metadataTokens.length === 1 ? '' : 's'}: ${metadataTokens.map(token => `\`${token}\``).join(', ')}`;
    } else if (sourceType === 'explicit-annotation') {
      storyEvidence = `grouping from explicit annotation: ${sources.map(source => `\`${escapeMarkdown(source)}\``).join(', ')}`;
    } else if (sourceType === 'mixed') {
      storyEvidence = 'grouping from mixed metadata-token and explicit-annotation evidence';
    } else {
      storyEvidence = escapeMarkdown(sources.join('; '));
    }
    return {
      name,
      title: GROUP_TITLES[name] || name,
      entity_count: entities.length,
      color: GROUP_PALETTES[name]?.[0] || entities[0]?.color || '#9AA0A6',
      source_type: sourceType,
      sources,
      evidence,
      metadata_tokens: metadataTokens,
      formal_biological_ontology_claimed: false,
      story_evidence: storyEvidence,
      entities,
    };
  });
}

function groupLegendMarkdown(groups) {
  const names = groups.map(group => `\`${group.name}\``).join(', ');
  return [
    '## Group legend',
    '',
    `Groups from source metadata or explicit annotations: ${names || 'none'}.`,
    'These groups are navigation aids, not claims of a formal biological ontology.',
    '',
    groupLinks(groups),
  ].join('\n');
}

function framingPolicy(bounds) {
  const maxExtent = Math.max(...bounds.extent);
  const largeModel = maxExtent >= 1000 || bounds.radius >= 750;
  const radiusFactor = largeModel ? 0.72 : 0.86;
  return {
    method: 'root focus from calculated assembly bounds',
    target: bounds.center.map(round3),
    source_radius: round3(bounds.radius),
    focus_radius_factor: radiusFactor,
    focus_radius: round3(bounds.radius * radiusFactor),
    large_model_margin_applied: largeModel,
    reset_zoom_controlled_by_story: false,
    reset_zoom_limitation: 'MolViewSpec initializes the scene camera, but the viewer Reset Zoom command recomputes framing from visible representations and is not controlled by the story.',
  };
}

function buildStory({ inputPath, assetName, inspection, entities, title, cutaway, axis, offset, maxGroupScenes, performancePreset, performanceProfile, intendedUse, coordinateUnit, guideScale }) {
  const bounds = inspection.assembly_bounds || inspection.source_bounds;
  if (!bounds) throw new Error('Could not calculate model bounds');
  const geometry = coordinateGeometry(bounds, coordinateUnit, guideScale);
  const custom = lodCustom(bounds);
  const fastMode = performancePreset === 'fast';
  const grouped = new Map();
  for (const entity of entities) {
    if (!grouped.has(entity.group)) grouped.set(entity.group, []);
    grouped.get(entity.group).push(entity);
  }
  const orderedGroups = [...grouped.entries()].sort((a, b) => {
    const ai = GROUP_ORDER.indexOf(a[0]);
    const bi = GROUP_ORDER.indexOf(b[0]);
    return (ai < 0 ? 999 : ai) - (bi < 0 ? 999 : bi) || a[0].localeCompare(b[0]);
  });
  const groups = groupSummaries(orderedGroups);
  const geometryText = geometryMarkdown(geometry);
  const legendText = groupLegendMarkdown(groups);
  const snapshots = [];
  const provenanceText = 'Component names are shown only when present in BCIF metadata or the supplied annotation map. Unnamed entities remain unassigned.';
  snapshots.push(snapshot(
    'exterior_overview',
    'Exterior overview',
    `# ${escapeMarkdown(title)}\n\nFull assembly overview rendered from \`${path.basename(inputPath)}\`.\n\n${geometryText}\n\n${legendText}\n\n${provenanceText}`,
    storyRoot(
      assetName,
      inspection.assembly_id,
      fastMode
        ? [
            contextNode(custom, null, 0.18),
            ...representativeNodes(groups, custom, null, 10, 1),
          ]
        : entities.map(entity => componentNode(entity, custom, null)),
      focusFor(bounds),
    ),
  ));

  const clip = cutaway ? clipParams(bounds, axis, offset) : null;
  if (cutaway) {
    snapshots.push(snapshot(
      'cutaway_interior',
      'Cutaway and interior',
      `# Cutaway and interior\n\nA plane through the calculated assembly bounds reveals packed internal geometry. This is a portable MolViewSpec reconstruction, not the original Mesoscale Explorer state.\n\n${geometryText}\n\n${legendText}\n\n${provenanceText}`,
      storyRoot(
        assetName,
        inspection.assembly_id,
        fastMode
          ? [
              contextNode(custom, clip, 0.18),
              ...representativeNodes(groups, custom, clip, 10, 1),
            ]
          : entities.map(entity => componentNode(entity, custom, clip)),
        focusFor(bounds, [1, 0.3, 0.85], 0.66),
        '#EEF1F4',
        diameterGuideNodes(geometry),
      ),
    ));
  }

  const groupSceneCount = Math.max(0, maxGroupScenes);
  for (const group of groups.slice(0, groupSceneCount)) {
    const members = group.entities;
    const sceneClip = ['interior', 'fiber'].includes(group.name) ? clip : null;
    snapshots.push(snapshot(
      `group_${safeId(group.name)}`,
      group.title,
      `# ${escapeMarkdown(group.title)}\n\n${group.entity_count} entity types; ${group.story_evidence}. This grouping is a navigation aid, not a formal biological ontology claim.\n\nSelected from explicit model identifiers. Click a component name to highlight and focus it.\n\n${entityLinks(members)}`,
      storyRoot(
        assetName,
        inspection.assembly_id,
        fastMode
          ? [
              contextNode(custom, sceneClip, 0.06),
              ...representativeEntities(group, 16).map(entity => componentNode(entity, custom, sceneClip, 1)),
            ]
          : [
              contextNode(custom, sceneClip, 0.06),
              ...members.map(entity => componentNode(entity, custom, sceneClip)),
            ],
        focusFor(bounds, group.name === 'interior' ? [1, 0.15, 0.7] : [0.65, 0.45, 1], 0.58),
      ),
    ));
  }

  return {
    kind: 'multiple',
    metadata: {
      title,
      description: 'General CellPACK/Mesoscale-style MolViewSpec story generated from BinaryCIF metadata.',
      description_format: 'markdown',
      timestamp: new Date().toISOString(),
      version: '1',
      performanceProfile,
      intendedUse,
      performancePreset,
    },
    snapshots,
  };
}

function validateMvsj(story) {
  const issues = [];
  if (story.kind !== 'multiple') issues.push('top-level kind must be "multiple"');
  if (!Array.isArray(story.snapshots) || story.snapshots.length < 1) issues.push('snapshots must be a non-empty array');
  const allowedKinds = new Set([
    'root', 'canvas', 'download', 'parse', 'structure', 'component',
    'representation', 'color', 'opacity', 'clip', 'focus', 'primitives', 'primitive',
  ]);
  const walk = (node, location) => {
    if (!node || typeof node !== 'object') {
      issues.push(`${location} is not an object`);
      return;
    }
    if (!allowedKinds.has(node.kind)) issues.push(`${location} has unsupported kind "${node.kind}"`);
    if (node.children && !Array.isArray(node.children)) issues.push(`${location}.children must be an array`);
    for (let i = 0; i < (node.children || []).length; i += 1) walk(node.children[i], `${location}.children[${i}]`);
  };
  for (let i = 0; i < (story.snapshots || []).length; i += 1) {
    const current = story.snapshots[i];
    if (!current.metadata?.key) issues.push(`snapshots[${i}] has no metadata.key`);
    walk(current.root, `snapshots[${i}].root`);
  }
  return { ok: issues.length === 0, issues };
}

function sha256(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

function writeReadme(outDir, manifest) {
  const geometry = manifest.coordinate_geometry;
  const groupLines = manifest.groups.map(group => (
    `- \`${group.name}\`: ${group.entity_count} entity types; source type: \`${group.source_type}\`; `
    + `evidence: ${group.evidence.map(item => `\`${item}\``).join(', ')}`
  )).join('\n');
  const text = `# CellPACK/Mesoscale Story

This directory contains a portable MolViewSpec reconstruction generated from a CellPACK-like BinaryCIF model.

## Files

- \`${manifest.story_file}\`: multi-snapshot MVSJ story.
- ${manifest.asset_file ? `\`${manifest.asset_file}\`: viewer model asset${manifest.curated_policy ? ' extracted from selected real BCIF assembly instances' : ' copied from the source model'}.` : 'No atomistic BinaryCIF is copied into this output; the story uses a lightweight proxy derived from the source model metadata.'}
- \`story_manifest.json\`: inspected metadata, provenance, bounds, and capability limits.

## Open Locally

\`\`\`bash
node scripts/server-docking-pipeline/serve_mvs_story.mjs --input "${outDir}" --port 8765
\`\`\`

The viewer loads the MVSJ through the existing local Mol* Stories wrapper.

## Performance Profile

- performanceProfile: \`${manifest.performance_profile}\`
- intendedUse: \`${manifest.intendedUse}\`
- technical preset: \`${manifest.performance_preset}\`

\`scientific\` is for interactive scientific inspection with richer component scenes.
\`overview\` is for smoother laptop autoplay and minimizes scene complexity by default.
\`coarse-overview\` creates a lightweight instance-center proxy from source BCIF metadata. It is a cinematic overview asset, not an atomistic inspection scene.
\`curated-presentation\` selects a bounded, deterministic subset of real CellPACK assembly instances for laptop presentation. It does not create proxy spheres and is not a full atomistic cell.
${manifest.proxy_policy ? `
## Coarse Proxy Policy

- proxy kind: \`${manifest.proxy_policy.proxy_kind}\`
- selected proxies: ${manifest.proxy_policy.selected_proxy_count} of ${manifest.proxy_policy.raw_instance_count} source assembly instances
- atomistic model loaded in viewer: ${manifest.proxy_policy.atomistic_model_loaded_in_viewer}
- sampling: ${manifest.proxy_policy.sampling_strategy}

This profile is intended for cinematic overview/autoplay. Use \`scientific\` when atomistic inspection is required.
` : ''}
${manifest.curated_policy ? `
## Curated Presentation Policy

- selected real instances: ${manifest.curated_policy.selected_instance_count}
- selected source atom count: ${manifest.curated_policy.selected_atom_count}
- random sampling: ${manifest.curated_policy.random_sampling}
- generic proxy geometry: ${manifest.curated_policy.generic_proxy_geometry}
- full-cell atomistic rendering: ${manifest.curated_policy.full_cell_atomistic_rendering}
- selection report: \`${manifest.selection_report_file}\`

This profile is intended for laptop Chrome molecular presentation. It uses source BCIF metadata and deterministic spatial selection, not random scatter or generic sphere proxies.
` : ''}

## Coordinate Geometry

- Coordinate extent: ${geometry.extent_x} x ${geometry.extent_y} x ${geometry.extent_z} coordinate units
- Max-axis extent: ${geometry.max_axis_extent} coordinate units along ${geometry.max_axis.toUpperCase()}
- Visible guide measurement: ${geometry.guide_label}
- Bounding-box diagonal: ${geometry.bounding_box_diagonal} coordinate units
- Physical unit source: ${geometry.physical_unit_source || 'not supplied; coordinate units only'}.

The cutaway scene includes a visible dashed guide across the main model extent. Physical units are shown only when the caller supplies \`--coordinate-unit\`; otherwise labels remain in coordinate units.

## Group Legend

${groupLines || '- No component groups were produced.'}

Groups derived from metadata tokens are navigation aids and do not imply a formal biological ontology. Explicit annotation groups retain their supplied provenance.

## Camera Framing

Initial scene framing uses a root-level MolViewSpec focus with radius ${manifest.camera_framing.focus_radius} coordinate units (${manifest.camera_framing.focus_radius_factor}x the calculated assembly bounding radius).

MolViewSpec does not control the viewer's later **Reset Zoom** command. Reset Zoom recomputes framing from visible representations and may behave differently from the story's initial camera, especially when application panels overlap an expanded viewport.

## Validation

Run the official MolViewSpec validator when available. The generator's \`--builtin-validate\` flag performs deterministic structural checks only; official validation remains the schema authority.

## Capability Boundary

This is a pure MVSJ explanatory reconstruction. It does not claim to reproduce Mol* Mesoscale Explorer plugin state, \`ms-plugin.mesoscale-group\`, \`ms-plugin.cellpack-structure\`, session snapshots, audio orchestration, or every renderer-specific postprocessing setting.
`;
  fs.writeFileSync(path.join(outDir, 'README.md'), text, 'utf8');
}

function round3(value) {
  return Math.round(value * 1000) / 1000;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help || args.h) {
    console.log(usage());
    return;
  }
  const inputPath = requiredFile(args.input || args._[0], 'input', '.bcif');
  const outputPath = args.output ? path.resolve(String(args.output)) : null;
  const outDir = outputPath
    ? path.dirname(outputPath)
    : path.resolve(String(args.outDir || path.join(path.dirname(inputPath), `${path.parse(inputPath).name}_cellpack_story`)));
  const storyPath = outputPath || path.join(outDir, 'story.mvsj');
  const title = String(args.title || `${path.parse(inputPath).name} CellPACK overview`);
  const cutaway = boolValue(args.cutaway, true);
  const builtinValidate = boolValue(args.builtinValidate ?? args.validate, false);
  const forceCellpack = boolValue(args.forceCellpack, false);
  const axis = String(args.clipAxis || 'x').toLowerCase();
  if (!['x', 'y', 'z'].includes(axis)) throw new Error('--clip-axis must be x, y, or z');
  const offset = numberValue(args.clipOffset, 0, 'clip_offset');
  if (Math.abs(offset) > 0.5) throw new Error('--clip-offset must be between -0.5 and 0.5');
  const performanceProfile = normalizePerformanceProfile(args.performanceProfile);
  const intendedUse = INTENDED_USE_BY_PROFILE[performanceProfile];
  const maxGroupScenes = Math.floor(numberValue(
    args.maxGroupScenes,
    defaultGroupSceneCountForProfile(performanceProfile),
    'max_group_scenes',
  ));
  const performancePreset = String(args.performancePreset || defaultPresetForProfile(performanceProfile)).toLowerCase();
  if (!['fast', 'balanced', 'quality'].includes(performancePreset)) {
    throw new Error('--performance-preset must be fast, balanced, or quality');
  }
  const maxProxies = Math.max(32, Math.floor(numberValue(
    args.maxProxies,
    defaultMaxProxiesForProfile(performanceProfile),
    'max_proxies',
  )));
  const proxyRadiusScale = numberValue(args.proxyRadiusScale, 0.38, 'proxy_radius_scale');
  if (proxyRadiusScale <= 0 || proxyRadiusScale > 10) throw new Error('--proxy-radius-scale must be > 0 and <= 10');
  const coordinateUnit = String(args.coordinateUnit || 'coordinate').toLowerCase();
  if (!['coordinate', 'angstrom', 'nanometer'].includes(coordinateUnit)) {
    throw new Error('--coordinate-unit must be coordinate, angstrom, or nanometer');
  }
  const guideScale = numberValue(args.guideScale, 0.42, 'guide_scale');
  if (guideScale <= 0 || guideScale > 1) throw new Error('--guide-scale must be > 0 and <= 1');
  const annotations = readAnnotationMap(args.annotationMap);
  const inspection = inspectCellpackModel(inputPath, {
    assemblyId: args.assemblyId,
    includeInstanceProxies: performanceProfile === 'coarse-overview' || performanceProfile === 'curated-presentation',
  });
  const classification = classifyStoryInput(inspection);
  if (!classification.accepted) {
    if (classification.classification === 'invalid-or-unsupported' || !forceCellpack) {
      throw new Error(formatClassificationRefusal(classification));
    }
    classification.overridden = true;
    classification.override_reason = '--force-cellpack supplied by caller';
  } else {
    classification.overridden = false;
  }
  const entities = enrichEntities(inspection, annotations);
  const bounds = inspection.assembly_bounds || inspection.source_bounds;
  const geometry = coordinateGeometry(bounds, coordinateUnit, guideScale);
  const grouped = new Map();
  for (const entity of entities) {
    if (!grouped.has(entity.group)) grouped.set(entity.group, []);
    grouped.get(entity.group).push(entity);
  }
  const orderedGroups = [...grouped.entries()].sort((a, b) => {
    const ai = GROUP_ORDER.indexOf(a[0]);
    const bi = GROUP_ORDER.indexOf(b[0]);
    return (ai < 0 ? 999 : ai) - (bi < 0 ? 999 : bi) || a[0].localeCompare(b[0]);
  });
  const groups = groupSummaries(orderedGroups).map(({ entities: members, ...group }) => group);

  // No output path is created until the input contract has passed preflight.
  fs.mkdirSync(outDir, { recursive: true });
  const coarseMode = performanceProfile === 'coarse-overview';
  const curatedMode = performanceProfile === 'curated-presentation';
  const assetName = coarseMode ? null : curatedMode ? 'curated_selection.cif' : path.basename(inputPath);
  const copiedAsset = coarseMode ? null : path.join(outDir, assetName);
  if (copiedAsset && !curatedMode && path.resolve(copiedAsset) !== path.resolve(inputPath)) fs.copyFileSync(inputPath, copiedAsset);
  const built = coarseMode ? buildCoarseStory({
    inputPath,
    inspection,
    entities,
    title,
    cutaway,
    axis,
    offset,
    maxProxies,
    proxyRadiusScale,
    performanceProfile,
    intendedUse,
    coordinateUnit,
    guideScale,
  }) : curatedMode ? buildCuratedStory({
    assetName,
    inspection,
    entities,
    title,
    cutaway,
    axis,
    offset,
    performanceProfile,
    intendedUse,
  }) : { story: buildStory({
    inputPath,
    assetName,
    inspection,
    entities,
    title,
    cutaway,
    axis,
    offset,
    maxGroupScenes,
    performancePreset,
    performanceProfile,
    intendedUse,
    coordinateUnit,
    guideScale,
  }), proxies: null, groups: null, geometry: null, proxy_policy: null };
  const { story } = built;
  const curatedExtraction = curatedMode ? writeSelectedAssemblyInstancesCif(
    inputPath,
    copiedAsset,
    built.selected_instances_for_extraction,
    { dataName: 'curated_cellpack_selection' },
  ) : null;
  const validation = validateMvsj(story);
  if (builtinValidate && !validation.ok) throw new Error(`Built-in MVSJ validation failed:\n${validation.issues.join('\n')}`);
  fs.writeFileSync(storyPath, `${JSON.stringify(story, null, 2)}\n`, 'utf8');
  if (built.selection_report) {
    built.selection_report.source_bcif = inputPath;
    fs.writeFileSync(path.join(outDir, 'selection_report.json'), `${JSON.stringify(built.selection_report, null, 2)}\n`, 'utf8');
  }

  const manifest = {
    generator: path.basename(SCRIPT_FILE),
    generator_mode: 'cellpack',
    capability_class: 'cellpack-mesoscale',
    input_classification: classification,
    generated_at: new Date().toISOString(),
    input_file: inputPath,
    input_sha256: sha256(inputPath),
    annotation_map: annotations.path,
    story_file: path.basename(storyPath),
    asset_file: assetName,
    atomistic_model_copied_to_output: Boolean(assetName),
    source_bcif_copied_to_output: Boolean(assetName && !curatedMode && !coarseMode),
    curated_extracted_model: curatedExtraction,
    scene_count: story.snapshots.length,
    scenes: story.snapshots.map(item => ({ key: item.metadata.key, title: item.metadata.title })),
    validation: {
      builtin_requested: builtinValidate,
      builtin_ok: validation.ok,
      builtin_issues: validation.issues,
      official_mvs_validation: 'not_run_by_generator',
    },
    inspection: manifestInspection(inspection),
    components: entities,
    coordinate_geometry: geometry,
    diameter_visualization: {
      cutaway_scene_has_visible_guide: Boolean(cutaway),
      primitive_kind: 'dashed distance_measurement with inline label',
      value: geometry.guide_extent,
      axis: geometry.max_axis,
      label: geometry.guide_label,
      units: coordinateUnit === 'coordinate' ? 'coordinate units' : coordinateUnit,
      physical_unit_claimed: coordinateUnit !== 'coordinate',
      physical_unit_source: geometry.physical_unit_source,
    },
    groups,
    performance_profile: performanceProfile,
    intendedUse,
    performance_preset: performancePreset,
    ...(built.proxy_policy ? { proxy_policy: built.proxy_policy } : {}),
    ...(built.curated_policy ? { curated_policy: built.curated_policy } : {}),
    ...(built.selected_groups ? { selected_groups: built.selected_groups } : {}),
    selection_report_file: built.selection_report ? 'selection_report.json' : null,
    scientificScope: performanceProfile === 'curated-presentation'
      ? 'Curated subset of real CellPACK molecular instances; not a complete atomistic cell.'
      : undefined,
    performance_policy: {
      profile: performanceProfile,
      intended_use: intendedUse,
      fast_uses_single_all_model_representation: performancePreset === 'fast',
      fast_keeps_lightweight_group_focus_scenes: performancePreset === 'fast',
      overview_minimizes_group_scenes_by_default: performanceProfile === 'overview',
      coarse_overview_uses_instance_center_primitives: performanceProfile === 'coarse-overview',
      curated_presentation_uses_selected_real_instances: performanceProfile === 'curated-presentation',
      scientific_semantics_changed: performanceProfile === 'coarse-overview',
    },
    group_policy: {
      metadata_token_groups_are_navigation_aids: true,
      formal_biological_ontology_claimed: false,
      explicit_annotation_groups_require_provenance: true,
    },
    camera_framing: framingPolicy(bounds),
    label_policy: {
      allowed_sources: [
        'BinaryCIF entity metadata',
        'BinaryCIF stable identifiers',
        'explicit JSON annotation map with provenance',
      ],
      guessed_biological_labels: false,
      missing_label: 'unassigned entity <label_entity_id>',
    },
    capability_boundary: {
      output: 'portable MolViewSpec MVSJ reconstruction',
      unsupported_not_faked: [
        'full Mol* Mesoscale Explorer state',
        'ms-plugin.mesoscale-group',
        'ms-plugin.cellpack-structure',
        'Mol* session snapshots and MOLX state',
        'audio orchestration',
        'renderer-specific state not represented by MVS/custom parameters',
      ],
    },
  };
  fs.writeFileSync(path.join(outDir, 'story_manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
  writeReadme(outDir, manifest);
  console.log(JSON.stringify({
    ok: true,
    mode: 'cellpack',
    out_dir: outDir,
    story: storyPath,
    asset: copiedAsset,
    manifest: path.join(outDir, 'story_manifest.json'),
    scene_count: story.snapshots.length,
    validation,
    input_classification: classification,
  }, null, 2));
}

if (path.resolve(process.argv[1]) === SCRIPT_FILE) {
  try {
    main();
  } catch (error) {
    console.error(error instanceof Error ? (error.stack || error.message) : String(error));
    process.exitCode = 1;
  }
}

export {
  buildStory,
  coordinateGeometry,
  enrichEntities,
  framingPolicy,
  groupSummaries,
  readAnnotationMap,
  validateMvsj,
};
