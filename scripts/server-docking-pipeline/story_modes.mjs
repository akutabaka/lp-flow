import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));

const STORY_MODES = Object.freeze({
  docking: {
    id: 'docking',
    capability_class: 'docking-ligand-binding',
    description: 'Protein-ligand docking result stories.',
    generator: path.join(SCRIPT_DIR, 'make_docking_story.mjs'),
    status: 'implemented',
    input_kinds: ['docking-results-directory', 'receptor-plus-ranked-poses'],
    output_artifact: 'mol-view-stories-source-directory',
    validator: 'story-manifest checks plus browser rendering',
    viewer_adapter: 'serve_mvs_story after upstream export',
    capabilities: {
      cutaway: false,
      grouping: true,
      markdown_refs: true,
      provenance_labels: true,
      audio: false,
      molstar_state: false,
    },
  },
  cellpack: {
    id: 'cellpack',
    aliases: ['mesoscale', 'cellpack-mesoscale'],
    capability_class: 'cellpack-mesoscale',
    description: 'Packed cellular, vesicle, and mesoscale BinaryCIF stories.',
    generator: path.join(SCRIPT_DIR, 'make_cellpack_story.mjs'),
    status: 'implemented',
    input_kinds: ['bcif:cellpack-mesoscale'],
    output_artifact: 'portable-mvsj-directory',
    validator: 'builtin structural checks plus official MolViewSpec validation',
    viewer_adapter: 'serve_mvs_story',
    capabilities: {
      cutaway: true,
      grouping: true,
      markdown_refs: true,
      provenance_labels: true,
      audio: false,
      molstar_state: false,
    },
  },
  structure: {
    id: 'structure',
    capability_class: 'ordinary-molecular-structure',
    description: 'Ordinary molecular structure narratives.',
    status: 'planned',
    input_kinds: ['pdb', 'cif', 'bcif:ordinary-structure'],
    output_artifact: null,
    validator: null,
    viewer_adapter: null,
    capabilities: {},
  },
  annotation: {
    id: 'annotation',
    capability_class: 'annotation-driven',
    description: 'Annotation-table-driven structure stories.',
    status: 'planned',
    input_kinds: ['structure-plus-explicit-annotation-map'],
    output_artifact: null,
    validator: null,
    viewer_adapter: null,
    capabilities: {},
  },
  primitives: {
    id: 'primitives',
    capability_class: 'primitive-explanatory',
    description: 'MolViewSpec primitive explanatory scenes.',
    status: 'planned',
    input_kinds: ['explicit-coordinates-and-primitives'],
    output_artifact: null,
    validator: null,
    viewer_adapter: null,
    capabilities: {},
  },
});

function resolveStoryMode(rawMode) {
  const mode = String(rawMode || '').trim().toLowerCase();
  for (const entry of Object.values(STORY_MODES)) {
    if (entry.id === mode || entry.aliases?.includes(mode)) return entry;
  }
  throw new Error(`Unknown story mode "${rawMode}". Available: ${Object.keys(STORY_MODES).join(', ')}`);
}

export { STORY_MODES, resolveStoryMode };
