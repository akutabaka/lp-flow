#!/usr/bin/env -S deno run --allow-read

/**
 * Optional official Mol* MolViewSpec validation.
 *
 * Run with Deno because the Mol* npm package is not bundled with the plugin:
 * deno run --allow-read scripts/server-docking-pipeline/validate_mvsj_official.mjs <story.mvsj>
 */

const input = Deno.args[0];
if (!input) {
  console.error('Usage: deno run --allow-read scripts/server-docking-pipeline/validate_mvsj_official.mjs <story.mvsj>');
  Deno.exit(2);
}

const { MVSData } = await import('npm:molstar/lib/extensions/mvs/mvs-data.js');
const raw = await Deno.readTextFile(input);
const data = MVSData.fromMVSJ(raw);
const issues = MVSData.validationIssues(data);
console.log(JSON.stringify({
  ok: issues === undefined,
  validator: 'molstar:MVSData.validationIssues',
  issues: issues || [],
}, null, 2));
if (issues !== undefined) Deno.exit(1);
