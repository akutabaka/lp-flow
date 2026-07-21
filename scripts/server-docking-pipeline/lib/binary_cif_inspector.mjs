/**
 * Small dependency-free BinaryCIF reader for metadata-driven story generation.
 *
 * MessagePack and BinaryCIF array decoding follow the Mol* implementation:
 * https://github.com/molstar/molstar (MIT license).
 * This module is intentionally read-only and decodes only ordinary BinaryCIF
 * columns; it is not a replacement for Mol* structure parsing.
 */

import fs from 'node:fs';

const textDecoder = new TextDecoder('utf-8');

function decodeMsgPack(buffer) {
  const bytes = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer);
  return parseMsgPack({
    buffer: bytes,
    offset: 0,
    dataView: new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength),
  });
}

function parseMsgPack(state) {
  const type = state.buffer[state.offset];
  let length;
  if ((type & 0x80) === 0x00) {
    state.offset += 1;
    return type;
  }
  if ((type & 0xf0) === 0x80) {
    length = type & 0x0f;
    state.offset += 1;
    return readMap(state, length);
  }
  if ((type & 0xf0) === 0x90) {
    length = type & 0x0f;
    state.offset += 1;
    return readArray(state, length);
  }
  if ((type & 0xe0) === 0xa0) {
    length = type & 0x1f;
    state.offset += 1;
    return readString(state, length);
  }
  if ((type & 0xe0) === 0xe0) {
    const value = state.dataView.getInt8(state.offset);
    state.offset += 1;
    return value;
  }
  switch (type) {
    case 0xc0: state.offset += 1; return null;
    case 0xc2: state.offset += 1; return false;
    case 0xc3: state.offset += 1; return true;
    case 0xc4:
      length = state.dataView.getUint8(state.offset + 1);
      state.offset += 2;
      return readBinary(state, length);
    case 0xc5:
      length = state.dataView.getUint16(state.offset + 1);
      state.offset += 3;
      return readBinary(state, length);
    case 0xc6:
      length = state.dataView.getUint32(state.offset + 1);
      state.offset += 5;
      return readBinary(state, length);
    case 0xca: {
      const value = state.dataView.getFloat32(state.offset + 1);
      state.offset += 5;
      return value;
    }
    case 0xcb: {
      const value = state.dataView.getFloat64(state.offset + 1);
      state.offset += 9;
      return value;
    }
    case 0xcc: {
      const value = state.dataView.getUint8(state.offset + 1);
      state.offset += 2;
      return value;
    }
    case 0xcd: {
      const value = state.dataView.getUint16(state.offset + 1);
      state.offset += 3;
      return value;
    }
    case 0xce: {
      const value = state.dataView.getUint32(state.offset + 1);
      state.offset += 5;
      return value;
    }
    case 0xd0: {
      const value = state.dataView.getInt8(state.offset + 1);
      state.offset += 2;
      return value;
    }
    case 0xd1: {
      const value = state.dataView.getInt16(state.offset + 1);
      state.offset += 3;
      return value;
    }
    case 0xd2: {
      const value = state.dataView.getInt32(state.offset + 1);
      state.offset += 5;
      return value;
    }
    case 0xd9:
      length = state.dataView.getUint8(state.offset + 1);
      state.offset += 2;
      return readString(state, length);
    case 0xda:
      length = state.dataView.getUint16(state.offset + 1);
      state.offset += 3;
      return readString(state, length);
    case 0xdb:
      length = state.dataView.getUint32(state.offset + 1);
      state.offset += 5;
      return readString(state, length);
    case 0xdc:
      length = state.dataView.getUint16(state.offset + 1);
      state.offset += 3;
      return readArray(state, length);
    case 0xdd:
      length = state.dataView.getUint32(state.offset + 1);
      state.offset += 5;
      return readArray(state, length);
    case 0xde:
      length = state.dataView.getUint16(state.offset + 1);
      state.offset += 3;
      return readMap(state, length);
    case 0xdf:
      length = state.dataView.getUint32(state.offset + 1);
      state.offset += 5;
      return readMap(state, length);
    default:
      throw new Error(`Unsupported MessagePack type 0x${type.toString(16)}`);
  }
}

function readMap(state, length) {
  const value = {};
  for (let i = 0; i < length; i += 1) {
    value[parseMsgPack(state)] = parseMsgPack(state);
  }
  return value;
}

function readArray(state, length) {
  const value = new Array(length);
  for (let i = 0; i < length; i += 1) value[i] = parseMsgPack(state);
  return value;
}

function readString(state, length) {
  const value = textDecoder.decode(state.buffer.subarray(state.offset, state.offset + length));
  state.offset += length;
  return value;
}

function readBinary(state, length) {
  const value = new Uint8Array(length);
  value.set(state.buffer.subarray(state.offset, state.offset + length));
  state.offset += length;
  return value;
}

function typedArray(type, size) {
  switch (type) {
    case 1: return new Int8Array(size);
    case 2: return new Int16Array(size);
    case 3: return new Int32Array(size);
    case 4: return new Uint8Array(size);
    case 5: return new Uint16Array(size);
    case 6: return new Uint32Array(size);
    case 32: return new Float32Array(size);
    case 33: return new Float64Array(size);
    default: throw new Error(`Unsupported BinaryCIF data type: ${type}`);
  }
}

function decodeByteArray(data, type) {
  if (type === 4) return data;
  const sizes = { 1: 1, 2: 2, 3: 4, 5: 2, 6: 4, 32: 4, 33: 8 };
  const size = sizes[type];
  if (!size) throw new Error(`Unsupported BinaryCIF byte-array type: ${type}`);
  const count = Math.floor(data.byteLength / size);
  const output = typedArray(type, count);
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const readers = {
    1: 'getInt8',
    2: 'getInt16',
    3: 'getInt32',
    5: 'getUint16',
    6: 'getUint32',
    32: 'getFloat32',
    33: 'getFloat64',
  };
  const reader = readers[type];
  for (let i = 0; i < count; i += 1) {
    output[i] = size === 1 ? view[reader](i) : view[reader](i * size, true);
  }
  return output;
}

function decodeArrayData(encoded) {
  let current = encoded.data;
  for (let i = encoded.encoding.length - 1; i >= 0; i -= 1) {
    const step = encoded.encoding[i];
    switch (step.kind) {
      case 'ByteArray':
        current = decodeByteArray(current, step.type);
        break;
      case 'FixedPoint': {
        const output = typedArray(step.srcType || 33, current.length);
        for (let j = 0; j < current.length; j += 1) output[j] = current[j] / step.factor;
        current = output;
        break;
      }
      case 'IntervalQuantization': {
        const output = typedArray(step.srcType || 33, current.length);
        const delta = (step.max - step.min) / (step.numSteps - 1);
        for (let j = 0; j < current.length; j += 1) output[j] = step.min + delta * current[j];
        current = output;
        break;
      }
      case 'RunLength': {
        const output = typedArray(step.srcType || 3, step.srcSize);
        let offset = 0;
        for (let j = 0; j < current.length; j += 2) {
          output.fill(current[j], offset, offset + current[j + 1]);
          offset += current[j + 1];
        }
        current = output;
        break;
      }
      case 'Delta': {
        const output = typedArray(step.srcType || 3, current.length);
        if (current.length) {
          output[0] = current[0] + (step.origin | 0);
          for (let j = 1; j < current.length; j += 1) output[j] = current[j] + output[j - 1];
        }
        current = output;
        break;
      }
      case 'IntegerPacking':
        current = decodeIntegerPacking(current, step);
        break;
      case 'StringArray': {
        const offsets = decodeArrayData({ encoding: step.offsetEncoding, data: step.offsets });
        const indices = decodeArrayData({ encoding: step.dataEncoding, data: current });
        const strings = [''];
        for (let j = 1; j < offsets.length; j += 1) {
          strings.push(step.stringData.substring(offsets[j - 1], offsets[j]));
        }
        current = Array.from(indices, index => strings[index + 1]);
        break;
      }
      default:
        throw new Error(`Unsupported BinaryCIF encoding: ${step.kind}`);
    }
  }
  return current;
}

function decodeIntegerPacking(data, encoding) {
  if (data.length === encoding.srcSize) return data;
  const output = new Int32Array(encoding.srcSize);
  const upper = encoding.byteCount === 1
    ? (encoding.isUnsigned ? 0xff : 0x7f)
    : (encoding.isUnsigned ? 0xffff : 0x7fff);
  const lower = encoding.isUnsigned ? null : -upper - 1;
  let source = 0;
  let target = 0;
  while (source < data.length && target < output.length) {
    let value = 0;
    let part = data[source];
    while (part === upper || part === lower) {
      value += part;
      source += 1;
      part = data[source];
    }
    output[target] = value + part;
    source += 1;
    target += 1;
  }
  return output;
}

function parseBinaryCif(inputPath) {
  const bytes = fs.readFileSync(inputPath);
  const unpacked = decodeMsgPack(bytes);
  if (!unpacked?.dataBlocks?.length) throw new Error('BinaryCIF contains no data blocks');
  const block = unpacked.dataBlocks[0];
  const categories = new Map();
  for (const raw of block.categories || []) {
    if (!raw || typeof raw !== 'object') continue;
    const name = String(raw.name || '').replace(/^_/, '');
    if (!name) continue;
    const columns = new Map();
    for (const column of raw.columns || []) {
      if (!column || typeof column !== 'object' || !column.name) continue;
      columns.set(column.name, column);
    }
    categories.set(name, { ...raw, name, columns });
  }
  return { version: unpacked.version, encoder: unpacked.encoder, header: block.header, categories };
}

function categoryTable(cif, name, fields) {
  const category = cif.categories.get(name);
  if (!category) return [];
  const decoded = new Map();
  for (const field of fields) {
    const column = category.columns.get(field);
    if (!column) continue;
    decoded.set(field, {
      values: decodeArrayData(column.data),
      mask: column.mask ? decodeArrayData(column.mask) : null,
    });
  }
  const rows = [];
  const explicitRowCount = Number(category.rowCount);
  const inferredRowCount = Math.max(0, ...[...decoded.values()].map(data => data.values?.length || 0));
  const rowCount = Number.isFinite(explicitRowCount) && explicitRowCount > 0 ? explicitRowCount : inferredRowCount;
  for (let i = 0; i < rowCount; i += 1) {
    const row = {};
    for (const field of fields) {
      const data = decoded.get(field);
      row[field] = !data || (data.mask && data.mask[i] !== 0) ? null : data.values[i];
    }
    rows.push(row);
  }
  return rows;
}

function emptyBounds() {
  return { min: [Infinity, Infinity, Infinity], max: [-Infinity, -Infinity, -Infinity] };
}

function includePoint(bounds, point) {
  for (let i = 0; i < 3; i += 1) {
    if (point[i] < bounds.min[i]) bounds.min[i] = point[i];
    if (point[i] > bounds.max[i]) bounds.max[i] = point[i];
  }
}

function includeBounds(target, source) {
  if (!isFiniteBounds(source)) return;
  includePoint(target, source.min);
  includePoint(target, source.max);
}

function isFiniteBounds(bounds) {
  return bounds.min.every(Number.isFinite) && bounds.max.every(Number.isFinite);
}

function finishBounds(bounds) {
  if (!isFiniteBounds(bounds)) return null;
  const center = bounds.min.map((value, index) => (value + bounds.max[index]) / 2);
  const extent = bounds.min.map((value, index) => bounds.max[index] - value);
  return {
    min: bounds.min.map(round3),
    max: bounds.max.map(round3),
    center: center.map(round3),
    extent: extent.map(round3),
    radius: round3(Math.hypot(...extent) / 2),
  };
}

function round3(value) {
  return Math.round(value * 1000) / 1000;
}

function parseOperationExpression(expression, available) {
  const groups = [...String(expression || '').matchAll(/\(([^)]+)\)/g)].map(match => match[1]);
  const rawGroups = groups.length ? groups : [String(expression || '')];
  const expanded = rawGroups.map(group => {
    const ids = [];
    for (const token of group.split(',').map(value => value.trim()).filter(Boolean)) {
      const range = /^(\d+)-(\d+)$/.exec(token);
      if (!range) {
        if (available.has(token)) ids.push(token);
        continue;
      }
      const start = Number(range[1]);
      const end = Number(range[2]);
      const step = start <= end ? 1 : -1;
      for (let value = start; value !== end + step; value += step) {
        if (available.has(String(value))) ids.push(String(value));
      }
    }
    return ids;
  }).filter(group => group.length);
  if (!expanded.length) return [];
  let products = [[]];
  for (const group of expanded) {
    products = products.flatMap(prefix => group.map(id => [...prefix, id]));
  }
  return products;
}

function identityTransform() {
  return { matrix: [[1, 0, 0], [0, 1, 0], [0, 0, 1]], vector: [0, 0, 0] };
}

function composeTransforms(left, right) {
  const matrix = [0, 1, 2].map(i => [0, 1, 2].map(j => (
    left.matrix[i][0] * right.matrix[0][j]
    + left.matrix[i][1] * right.matrix[1][j]
    + left.matrix[i][2] * right.matrix[2][j]
  )));
  const rightVector = applyTransform(left, right.vector);
  return {
    matrix,
    vector: rightVector.map((value, index) => value + left.vector[index]),
  };
}

function combinedTransform(ids, operations) {
  let transform = identityTransform();
  for (const id of ids) transform = composeTransforms(operations.get(id), transform);
  return transform;
}

function applyTransform(transform, point) {
  return transform.matrix.map((row, index) => (
    row[0] * point[0] + row[1] * point[1] + row[2] * point[2] + transform.vector[index]
  ));
}

function transformedBounds(bounds, transform) {
  const result = emptyBounds();
  for (const x of [bounds.min[0], bounds.max[0]]) {
    for (const y of [bounds.min[1], bounds.max[1]]) {
      for (const z of [bounds.min[2], bounds.max[2]]) {
        includePoint(result, applyTransform(transform, [x, y, z]));
      }
    }
  }
  return result;
}

function cifValue(value) {
  if (value === null || value === undefined || value === '') return '.';
  const text = String(value);
  if (/^[A-Za-z0-9_.+-]+$/.test(text)) return text;
  return `'${text.replace(/'/g, "''")}'`;
}

function writeSelectedAssemblyInstancesCif(inputPath, outputPath, instances, options = {}) {
  if (!Array.isArray(instances) || !instances.length) {
    throw new Error('No selected instances were provided for curated CIF extraction');
  }
  const cif = parseBinaryCif(inputPath);
  const atomRows = categoryTable(cif, 'atom_site', [
    'group_PDB', 'id', 'type_symbol', 'label_atom_id', 'label_alt_id', 'label_comp_id',
    'label_asym_id', 'label_entity_id', 'label_seq_id', 'pdbx_PDB_ins_code',
    'Cartn_x', 'Cartn_y', 'Cartn_z', 'occupancy', 'B_iso_or_equiv',
    'auth_seq_id', 'auth_comp_id', 'auth_asym_id', 'auth_atom_id', 'pdbx_PDB_model_num',
  ]);
  const atomsByAsym = new Map();
  for (const atom of atomRows) {
    const asym = String(atom.label_asym_id || '');
    if (!asym) continue;
    if (!atomsByAsym.has(asym)) atomsByAsym.set(asym, []);
    atomsByAsym.get(asym).push(atom);
  }
  const operationRows = categoryTable(cif, 'pdbx_struct_oper_list', [
    'id',
    'matrix[1][1]', 'matrix[1][2]', 'matrix[1][3]', 'vector[1]',
    'matrix[2][1]', 'matrix[2][2]', 'matrix[2][3]', 'vector[2]',
    'matrix[3][1]', 'matrix[3][2]', 'matrix[3][3]', 'vector[3]',
  ]);
  const operations = new Map(operationRows.map(row => [String(row.id), {
    matrix: [1, 2, 3].map(i => [1, 2, 3].map(j => Number(row[`matrix[${i}][${j}]`]))),
    vector: [1, 2, 3].map(i => Number(row[`vector[${i}]`])),
  }]));

  const lines = [
    `data_${String(options.dataName || 'curated_cellpack_selection').replace(/[^A-Za-z0-9_.-]+/g, '_')}`,
    '#',
    '_entry.id curated_cellpack_selection',
    '#',
    'loop_',
    '_atom_site.group_PDB',
    '_atom_site.id',
    '_atom_site.type_symbol',
    '_atom_site.label_atom_id',
    '_atom_site.label_alt_id',
    '_atom_site.label_comp_id',
    '_atom_site.label_asym_id',
    '_atom_site.label_entity_id',
    '_atom_site.label_seq_id',
    '_atom_site.pdbx_PDB_ins_code',
    '_atom_site.Cartn_x',
    '_atom_site.Cartn_y',
    '_atom_site.Cartn_z',
    '_atom_site.occupancy',
    '_atom_site.B_iso_or_equiv',
    '_atom_site.auth_seq_id',
    '_atom_site.auth_comp_id',
    '_atom_site.auth_asym_id',
    '_atom_site.auth_atom_id',
    '_atom_site.pdbx_PDB_model_num',
  ];

  let atomId = 1;
  const summary = [];
  for (const instance of instances) {
    const sourceAsym = String(instance.label_asym_id || '');
    const outputAsym = String(instance.output_label_asym_id || instance.curated_asym_id || sourceAsym);
    const sourceAtoms = atomsByAsym.get(sourceAsym) || [];
    const operationIds = Array.isArray(instance.operation_ids) ? instance.operation_ids.map(String) : [];
    const transform = operationIds.length ? combinedTransform(operationIds, operations) : identityTransform();
    let written = 0;
    for (const atom of sourceAtoms) {
      const point = [Number(atom.Cartn_x), Number(atom.Cartn_y), Number(atom.Cartn_z)];
      if (point.some(value => !Number.isFinite(value))) continue;
      const transformed = applyTransform(transform, point);
      const entityId = String(atom.label_entity_id || instance.source_entity || instance.entity_id || '1');
      const compId = atom.label_comp_id || atom.auth_comp_id || 'UNK';
      const atomName = atom.label_atom_id || atom.auth_atom_id || atom.type_symbol || 'X';
      const typeSymbol = atom.type_symbol || String(atomName).replace(/[^A-Za-z]/g, '').slice(0, 2) || 'X';
      lines.push([
        atom.group_PDB || 'ATOM',
        atomId,
        typeSymbol,
        atomName,
        atom.label_alt_id || '.',
        compId,
        outputAsym,
        entityId,
        atom.label_seq_id || atom.auth_seq_id || '.',
        atom.pdbx_PDB_ins_code || '?',
        transformed[0].toFixed(3),
        transformed[1].toFixed(3),
        transformed[2].toFixed(3),
        atom.occupancy ?? '1.00',
        atom.B_iso_or_equiv ?? '0.00',
        atom.auth_seq_id || atom.label_seq_id || '.',
        compId,
        outputAsym,
        atomName,
        atom.pdbx_PDB_model_num || '1',
      ].map(cifValue).join(' '));
      atomId += 1;
      written += 1;
    }
    summary.push({
      source_label_asym_id: sourceAsym,
      output_label_asym_id: outputAsym,
      operation_ids: operationIds,
      atom_count: written,
    });
  }
  lines.push('#');
  fs.writeFileSync(outputPath, `${lines.join('\n')}\n`, 'utf8');
  return {
    output_path: outputPath,
    atom_count: atomId - 1,
    instance_count: summary.length,
    instances: summary,
  };
}

function inspectCellpackModel(inputPath, options = {}) {
  const cif = parseBinaryCif(inputPath);
  const includeInstanceProxies = options.includeInstanceProxies === true;
  const entityRows = categoryTable(cif, 'entity', [
    'id', 'type', 'details', 'pdbx_description', 'pdbx_number_of_molecules',
  ]);
  const refRows = categoryTable(cif, 'struct_ref', [
    'entity_id', 'db_name', 'db_code', 'pdbx_db_accession', 'details',
  ]);
  const atomRows = categoryTable(cif, 'atom_site', [
    'label_entity_id', 'label_asym_id', 'Cartn_x', 'Cartn_y', 'Cartn_z',
  ]);
  if (!atomRows.length) throw new Error('BinaryCIF has no atom_site coordinates');

  const asymBounds = new Map();
  const asymEntity = new Map();
  const asymAtomCounts = new Map();
  const entityAtomCounts = new Map();
  const sourceBounds = emptyBounds();
  for (const atom of atomRows) {
    const asym = String(atom.label_asym_id ?? '');
    const entity = String(atom.label_entity_id ?? '');
    const point = [Number(atom.Cartn_x), Number(atom.Cartn_y), Number(atom.Cartn_z)];
    if (!asym || point.some(value => !Number.isFinite(value))) continue;
    if (!asymBounds.has(asym)) asymBounds.set(asym, emptyBounds());
    includePoint(asymBounds.get(asym), point);
    includePoint(sourceBounds, point);
    asymAtomCounts.set(asym, (asymAtomCounts.get(asym) || 0) + 1);
    if (entity) entityAtomCounts.set(entity, (entityAtomCounts.get(entity) || 0) + 1);
    if (entity) asymEntity.set(asym, entity);
  }

  const operationRows = categoryTable(cif, 'pdbx_struct_oper_list', [
    'id',
    'matrix[1][1]', 'matrix[1][2]', 'matrix[1][3]', 'vector[1]',
    'matrix[2][1]', 'matrix[2][2]', 'matrix[2][3]', 'vector[2]',
    'matrix[3][1]', 'matrix[3][2]', 'matrix[3][3]', 'vector[3]',
  ]);
  const operations = new Map(operationRows.map(row => [String(row.id), {
    matrix: [1, 2, 3].map(i => [1, 2, 3].map(j => Number(row[`matrix[${i}][${j}]`]))),
    vector: [1, 2, 3].map(i => Number(row[`vector[${i}]`])),
  }]));
  const assemblyRows = categoryTable(cif, 'pdbx_struct_assembly_gen', [
    'assembly_id', 'oper_expression', 'asym_id_list',
  ]);
  const assemblyIds = [...new Set(assemblyRows.map(row => String(row.assembly_id)).filter(Boolean))];
  const assemblyId = String(options.assemblyId || assemblyIds[0] || '');
  const selectedAssembly = assemblyRows.filter(row => String(row.assembly_id) === assemblyId);

  const assemblyBounds = emptyBounds();
  const entityAssemblyBounds = new Map();
  const entityInstanceKeys = new Map();
  const instanceProxies = [];
  for (const row of selectedAssembly) {
    const operationProducts = parseOperationExpression(row.oper_expression, operations);
    const asyms = String(row.asym_id_list || '').split(',').map(value => value.trim()).filter(Boolean);
    for (const asym of asyms) {
      const bounds = asymBounds.get(asym);
      if (!bounds) continue;
      const entity = asymEntity.get(asym) || '';
      for (const product of operationProducts.length ? operationProducts : [[]]) {
        const transform = product.length ? combinedTransform(product, operations) : identityTransform();
        const transformed = transformedBounds(bounds, transform);
        includeBounds(assemblyBounds, transformed);
        if (includeInstanceProxies) {
          const finished = finishBounds(transformed);
          if (finished) {
            instanceProxies.push({
              entity_id: entity || null,
              label_asym_id: asym,
              operation_ids: product,
              instance_key: `${asym}:${product.join('*') || 'identity'}`,
              center: finished.center,
              radius: finished.radius,
              extent: finished.extent,
              source_atom_count: asymAtomCounts.get(asym) || 0,
            });
          }
        }
        if (entity) {
          if (!entityAssemblyBounds.has(entity)) entityAssemblyBounds.set(entity, emptyBounds());
          includeBounds(entityAssemblyBounds.get(entity), transformed);
          if (!entityInstanceKeys.has(entity)) entityInstanceKeys.set(entity, new Set());
          entityInstanceKeys.get(entity).add(`${asym}:${product.join('*') || 'identity'}`);
        }
      }
    }
  }

  if (!isFiniteBounds(assemblyBounds)) includeBounds(assemblyBounds, sourceBounds);
  const refsByEntity = new Map();
  for (const row of refRows) {
    const id = String(row.entity_id || '');
    if (!refsByEntity.has(id)) refsByEntity.set(id, []);
    refsByEntity.get(id).push({
      db_name: row.db_name || null,
      db_code: row.db_code || null,
      accession: row.pdbx_db_accession || null,
      details: row.details || null,
    });
  }

  const asymByEntity = new Map();
  for (const [asym, entity] of asymEntity) {
    if (!asymByEntity.has(entity)) asymByEntity.set(entity, []);
    asymByEntity.get(entity).push(asym);
  }
  const entities = entityRows.map(row => {
    const id = String(row.id);
    const description = cleanText(row.pdbx_description);
    const details = cleanText(row.details);
    const source = description ? 'bcif:entity.pdbx_description'
      : details ? 'bcif:entity.details'
        : 'generated:unassigned';
    return {
      id,
      type: cleanText(row.type) || 'unknown',
      description: description || details || null,
      details: details || null,
      label: description || details || `unassigned entity ${id}`,
      label_source: source,
      asym_count: asymByEntity.get(id)?.length || 0,
      asym_ids_sample: (asymByEntity.get(id) || []).sort().slice(0, 12),
      source_atom_count: entityAtomCounts.get(id) || 0,
      instance_count: entityInstanceKeys.get(id)?.size || 0,
      bounds: finishBounds(entityAssemblyBounds.get(id) || emptyBounds()),
      references: refsByEntity.get(id) || [],
    };
  });

  return {
    format: 'BinaryCIF',
    version: cif.version,
    encoder: cif.encoder || null,
    block_header: cif.header || null,
    category_names: [...cif.categories.keys()].sort(),
    assembly_id: assemblyId || null,
    assembly_ids: assemblyIds,
    assembly_gen_row_count: selectedAssembly.length,
    atom_count: atomRows.length,
    asym_count: asymBounds.size,
    operation_count: operations.size,
    total_instance_count: [...entityInstanceKeys.values()].reduce((sum, keys) => sum + keys.size, 0),
    max_entity_instance_count: Math.max(0, ...[...entityInstanceKeys.values()].map(keys => keys.size)),
    source_bounds: finishBounds(sourceBounds),
    assembly_bounds: finishBounds(assemblyBounds),
    entities,
    ...(includeInstanceProxies ? { instance_proxies: instanceProxies } : {}),
  };
}

function cleanText(value) {
  const text = value === null || value === undefined ? '' : String(value).trim();
  return text && text !== '.' && text !== '?' ? text : '';
}

export {
  decodeArrayData,
  decodeMsgPack,
  inspectCellpackModel,
  parseBinaryCif,
  writeSelectedAssemblyInstancesCif,
};
