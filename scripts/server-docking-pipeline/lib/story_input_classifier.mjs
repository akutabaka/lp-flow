const CELLPACK_TERMS = Object.freeze([
  'cellpack',
  'mesoscale',
  'mesoscope',
  'compartment',
  'vesicle',
  'bilayer',
  'membrane',
  'lumen',
  'packed',
  'surface',
  'interior',
  'cargo',
  'envelope',
  'fiber',
  'filament',
]);

function finiteNumber(value, fallback = 0) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function modelExtent(inspection) {
  const extent = inspection?.assembly_bounds?.extent || inspection?.source_bounds?.extent || [];
  return Math.max(0, ...extent.map(value => finiteNumber(value)));
}

function metadataEvidence(inspection) {
  const sources = [
    inspection?.block_header,
    inspection?.encoder,
    ...(inspection?.category_names || []),
    ...(inspection?.entities || []).flatMap(entity => [
      entity.description,
      entity.details,
      ...(entity.references || []).flatMap(reference => [
        reference.db_name,
        reference.db_code,
        reference.accession,
        reference.details,
      ]),
    ]),
  ].filter(Boolean);
  const haystack = sources.join('\n').toLowerCase();
  const terms = CELLPACK_TERMS.filter(term => haystack.includes(term));
  const explicit = ['cellpack', 'mesoscale', 'mesoscope'].filter(term => haystack.includes(term));
  return {
    matched_terms: terms,
    explicit_terms: explicit,
    source_count: sources.length,
  };
}

function classifyStoryInput(inspection) {
  const atomCount = finiteNumber(inspection?.atom_count);
  const entityCount = Array.isArray(inspection?.entities) ? inspection.entities.length : 0;
  const asymCount = finiteNumber(inspection?.asym_count);
  const operationCount = finiteNumber(inspection?.operation_count);
  const assemblyRowCount = finiteNumber(inspection?.assembly_gen_row_count);
  const totalInstanceCount = finiteNumber(
    inspection?.total_instance_count,
    (inspection?.entities || []).reduce((sum, entity) => sum + finiteNumber(entity.instance_count), 0),
  );
  const maxEntityInstanceCount = finiteNumber(
    inspection?.max_entity_instance_count,
    Math.max(0, ...(inspection?.entities || []).map(entity => finiteNumber(entity.instance_count))),
  );
  const maxExtent = modelExtent(inspection);
  const metadata = metadataEvidence(inspection);
  const hasBounds = Boolean(inspection?.assembly_bounds || inspection?.source_bounds);
  const hasCoordinates = atomCount > 0 && hasBounds;
  const explicitCellpackMetadata = metadata.explicit_terms.length > 0;
  const semanticMetadata = metadata.matched_terms.length >= 2;

  const strongPackedComplexity = (
    operationCount >= 50
    && asymCount >= 20
    && totalInstanceCount >= 50
  ) || (
    entityCount >= 10
    && asymCount >= 50
    && totalInstanceCount >= 100
  ) || (
    atomCount >= 50000
    && maxExtent >= 500
    && totalInstanceCount >= 50
  );
  const overwhelmingPackedComplexity = (
    operationCount >= 500
    && asymCount >= 100
    && totalInstanceCount >= 500
    && maxExtent >= 500
  );
  const moderatePackedComplexity = (
    operationCount >= 10
    || totalInstanceCount >= 20
    || asymCount >= 20
    || assemblyRowCount >= 10
  );
  const ordinaryScale = (
    atomCount <= 10000
    && entityCount <= 5
    && asymCount <= 10
    && operationCount <= 10
    && totalInstanceCount <= 20
    && maxExtent <= 250
  );
  const simpleAssembly = (
    entityCount <= 2
    && asymCount <= 4
    && operationCount <= 4
    && totalInstanceCount <= 8
    && maxExtent <= 350
  );

  const evidence = {
    atom_count: atomCount,
    entity_count: entityCount,
    asym_count: asymCount,
    operation_count: operationCount,
    assembly_gen_row_count: assemblyRowCount,
    total_instance_count: totalInstanceCount,
    max_entity_instance_count: maxEntityInstanceCount,
    max_extent_coordinate_units: maxExtent,
    metadata_terms: metadata.matched_terms,
    explicit_cellpack_terms: metadata.explicit_terms,
    has_bounds: hasBounds,
  };

  if (!hasCoordinates || entityCount === 0 || asymCount === 0) {
    return {
      classification: 'invalid-or-unsupported',
      accepted: false,
      confidence: 'high',
      evidence,
      reasons: [
        !hasCoordinates ? 'The BinaryCIF does not expose usable atom coordinates and finite bounds.' : null,
        entityCount === 0 ? 'No entity metadata was found.' : null,
        asymCount === 0 ? 'No label_asym_id values were found.' : null,
      ].filter(Boolean),
      missing_evidence: ['usable atom_site coordinates', 'entity/asym identifiers'],
      recommendation: 'Use a supported coordinate model with entity/asym metadata.',
    };
  }

  if (
    (explicitCellpackMetadata && moderatePackedComplexity)
    || (semanticMetadata && strongPackedComplexity)
    || (metadata.matched_terms.length > 0 && overwhelmingPackedComplexity)
  ) {
    return {
      classification: 'cellpack-mesoscale',
      accepted: true,
      confidence: explicitCellpackMetadata || overwhelmingPackedComplexity ? 'high' : 'moderate',
      evidence,
      reasons: [
        explicitCellpackMetadata
          ? `Explicit CellPACK/Mesoscale metadata terms: ${metadata.explicit_terms.join(', ')}.`
          : `Model metadata contains multiple packed-model terms: ${metadata.matched_terms.join(', ')}.`,
        `Assembly complexity is consistent with a packed model (${asymCount} asyms, ${operationCount} operations, ${totalInstanceCount} instances, ${maxExtent} coordinate-unit extent).`,
      ],
      missing_evidence: [],
      recommendation: 'Proceed with the CellPACK/Mesoscale story generator.',
    };
  }

  if ((ordinaryScale || simpleAssembly) && !explicitCellpackMetadata && metadata.matched_terms.length === 0) {
    return {
      classification: 'ordinary-structure',
      accepted: false,
      confidence: 'high',
      evidence,
      reasons: [
        `The model is a small/simple assembly (${atomCount} atoms, ${entityCount} entities, ${asymCount} asyms, ${operationCount} operations, ${totalInstanceCount} instances).`,
        'No explicit CellPACK/Mesoscale or compartment metadata was found.',
      ],
      missing_evidence: [
        'packed-instance complexity',
        'CellPACK/Mesoscale metadata or multiple explicit compartment annotations',
      ],
      recommendation: 'Use the ordinary structure story mode when available; do not describe this input as CellPACK.',
    };
  }

  return {
    classification: 'ambiguous',
    accepted: false,
    confidence: 'low',
    evidence,
    reasons: [
      'The model is more complex than a typical small structure, but the available metadata is insufficient to establish a CellPACK/Mesoscale packed model.',
    ],
    missing_evidence: [
      'explicit CellPACK/Mesoscale metadata',
      'or a stronger combination of repeated instances, assembly operations, model scale, and compartment annotations',
    ],
    recommendation: 'Provide an explicit annotation/manifest or use --force-cellpack only when the model is independently known to be CellPACK-like.',
  };
}

function formatClassificationRefusal(result) {
  return [
    `Input classified as ${result.classification}, not CellPACK/Mesoscale.`,
    `Reasons: ${result.reasons.join(' ')}`,
    `Missing evidence: ${result.missing_evidence.join('; ')}.`,
    result.recommendation,
    result.classification === 'invalid-or-unsupported'
      ? null
      : 'To override only for an independently verified CellPACK-like model, pass --force-cellpack true.',
  ].filter(Boolean).join('\n');
}

export {
  CELLPACK_TERMS,
  classifyStoryInput,
  formatClassificationRefusal,
};
