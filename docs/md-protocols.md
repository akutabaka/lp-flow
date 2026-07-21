# MD Protocols

The built-in protein-ligand smoke workflow uses `amber99sb-ildn_gaff2`:
`amber99sb-ildn` for the protein and GAFF2 parameters generated through ACPYPE
for the ligand. Its manifest records that protocol and labels any external
tutorial equivalence as `not_claimed`.

The classic GROMACS 3HTB-JZ4 protein-ligand tutorial uses a CHARMM/CGenFF
workflow. Treat it as a separate protocol: use compatible supplied CHARMM36 and
CGenFF ligand topology assets before reporting tutorial-equivalent results.

Both protocols use the same artifact boundary: topology is generated from clean
ligand chemistry, the selected pose supplies placement, and the no-water
multi-model PDB is the Burrete display artifact. Native trajectory, topology,
metrics, and logs remain provenance for interpretation.
