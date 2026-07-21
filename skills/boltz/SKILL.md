---
name: boltz
description: >
  Structure prediction and triage of protein, nucleic-acid, and small-molecule
  complexes with Boltz-2 (Passaro & Wohlwend et al. 2025,
  github.com/jwohlwend/boltz): co-folding with SMILES or CCD ligands,
  confidence ranking, and optional protein-ligand affinity as a computational
  triage signal, using the configured local machine or server profile.
license: CC-BY-NC-4.0
metadata:
  lp-flow-compatibility: Requires LP-Flow, Node.js 20+, and a configured Boltz runtime; GPU and network-backed MSA may be optional.
  lp-flow-category: biomodels
  lp-flow-requirements: configured-runtime, optional-gpu
  lp-flow-third-party: Boltz-2 and optional ColabFold MSA service; see THIRD_PARTY_NOTICES.md.
---

# Boltz-2

Boltz-2 is an open-weights co-folding model for protein, nucleic-acid, and
ligand complexes: YAML chains in, mmCIF plus pTM/ipTM/pLDDT confidences out,
with an optional small-molecule affinity head. Code and weights are MIT (PyPI
`boltz`, github.com/jwohlwend/boltz). Heavy runs use a configured local machine
or server profile. Resolve commands, versions, writable output directory, and
accelerator availability from the active profile or wrapper before execution.

## Running it

```yaml
# complex.yaml
version: 1
sequences:
  - protein:
      id: A
      sequence: MVTPEGNVSLVDESLLVGVTDEDRAVRS...   # target
  - protein:
      id: B
      sequence: AIQRTPKIQVYSRHPAENG...            # binder
  - ligand:
      id: L
      smiles: 'N[C@@H](Cc1ccc(O)cc1)C(=O)O'      # or ccd: SAH
```

```bash
boltz predict complex.yaml \
    --use_msa_server --out_dir out/ --recycling_steps 3 --diffusion_samples 5
```

Each protein chain needs an MSA. Missing MSA makes the run exit before the model
loads. `--use_msa_server` queries `api.colabfold.com`; use it only when external
sequence submission is allowed. Use an existing `.a3m` under `msa:` when
available. Setting `msa: empty` forces single-sequence mode and trades away
accuracy. For GPU memory relief, lower `--diffusion_samples` or
`--max_parallel_samples`, or move to a larger GPU.

Per input, outputs land under `out/boltz_results_<name>/predictions/<name>/`.
Read `confidence_<name>_model_0.json` first: `iptm` above about 0.5 is the
common interface triage line, `complex_plddt` above about 0.7 supports the fold,
and `confidence_score` is the weighted aggregate used for ranking. These are
triage signals, not experimental binding validation. Structures are
`<name>_model_{0..N-1}.cif` unless `--output_format pdb` is requested.

## Input assumptions

Set chain IDs, protein sequences, ligand CCD or SMILES, ligand protonation and
stereochemistry, multimer stoichiometry, and MSA policy before running.

## Affinity head

Add a `properties:` block naming one `ligand` chain as the binder and Boltz-2
predicts protein-small-molecule binding affinity alongside the structure:

```yaml
properties:
  - affinity:
      binder: L            # ligand chain id
```

Output gains `affinity_<name>.json` next to the confidence file.
`affinity_pred_value` is log10(IC50 in uM), so lower is tighter; values near 0
mean about 1 uM and values near -3 mean about 1 nM.
`affinity_probability_binary` is the binder-vs-non-binder score to rank hits by.
Keep the raw JSON beside any summary. Treat predicted affinity as ranking/triage,
not a measured binding constant.

## Fast-kernel fallback

`ImportError` for `cuequivariance_ops_torch` or its `libcue_ops.so` means the
loader fails to find the compiled triangle-kernel package. `--no_kernels` falls
back to the reference PyTorch path: slower, but useful for a one-off while the
environment is repaired.

## Errors worth recognizing

| You see | It means / do this |
|---|---|
| Missing or absent MSA / `FileNotFoundError: MSA file ... not found` | Add `--use_msa_server`, set `msa:` to an `.a3m`/CSV path, or explicitly set `msa: empty` for single-sequence mode. |
| Kernel import failure: cuEquivariance / Triton / triangle update / `libcue_ops.so` | Retry with `--no_kernels` for slower PyTorch fallback, or repair CUDA/Triton/cuEquivariance install. |

## Output conditions

| You see | It means / do this |
|---|---|
| Confidence parser cannot find interface metrics such as `iptm` | Treat as parser/format mismatch; read available fields such as `ptm` and preserve raw confidence JSON. |
| `affinity_*.json` absent | Check YAML input, `properties.affinity.binder`, one small-molecule ligand chain, protein target, and ligand atom-count limits. |

---

**Continue:** compute clash and interface metrics on passing complexes when the
request includes downstream review or ranking.
