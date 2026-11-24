#!/bin/bash
# The builtin OpenFOAM pipeline for the case folder it runs in: mesh (blockMesh, surface features,
# snappyHexMesh, each when its dictionary is there), initial fields from 0.orig, decompose, potentialFoam
# (POTENTIAL=1), the controlDict's solver, reconstruct. A fresh run: earlier results in the case go first.
#   env: NP (ranks, default 1), CFD_STAGES (where each stage is noted), POTENTIAL, KEEP_PROCESSORS
set -Eeo pipefail
trap 'echo "of-run.sh line $LINENO: \"$BASH_COMMAND\" exited $?" >&2' ERR
NP=${NP:-1}
STAGES=${CFD_STAGES:-log.stages}
stage() { echo "$(date +%T) $1" >> "$STAGES"; }
edit() { sed -E "$1" "$2" > "$2.cfd-tmp" && mv "$2.cfd-tmp" "$2"; }  # sed -i differs between GNU and BSD
has() { [ -f "system/$1" ]; }
APP=$(sed -n -E 's/^[[:space:]]*application[[:space:]]+([A-Za-z0-9_]+)[[:space:]]*;.*/\1/p' system/controlDict | head -1)
[ -n "$APP" ] || { echo "system/controlDict names no application"; exit 2; }
command -v "$APP" > /dev/null || { echo "$APP isn't on PATH: is OpenFOAM's bashrc sourced?"; exit 2; }
MPI="mpirun --allow-run-as-root --oversubscribe --bind-to none -np $NP"
SNAPPY=0; has snappyHexMeshDict && SNAPPY=1

stage start
rm -rf processor* postProcessing
for d in [0-9]*; do
  if [[ "$d" =~ ^[0-9.eE+-]+$ && "$d" != 0 ]]; then rm -rf "$d"; fi
done
# snappy changes the patches, so the fields come from 0.orig once it's done
if [ $SNAPPY = 1 ] && [ ! -d 0.orig ] && [ -d 0 ]; then cp -r 0 0.orig; fi
if [ -d 0.orig ]; then rm -rf 0; fi

if has blockMeshDict; then
  stage blockMesh
  rm -rf constant/polyMesh
  blockMesh > log.blockMesh 2>&1
fi
if has surfaceFeatureExtractDict; then
  surfaceFeatureExtract > log.surfaceFeatureExtract 2>&1
elif has surfaceFeaturesDict; then
  surfaceFeatures > log.surfaceFeatures 2>&1
fi
fields() {  # put 0.orig in place, in the case or in each processor folder
  [ -d 0.orig ] || return 0
  if [ "$NP" -gt 1 ] && ls -d processor* > /dev/null 2>&1; then
    for p in processor*; do rm -rf "$p/0"; cp -r 0.orig "$p/0"; done
  else
    rm -rf 0; cp -r 0.orig 0
  fi
}
if [ "$NP" -gt 1 ]; then
  if ! has decomposeParDict; then
    printf 'FoamFile { version 2.0; format ascii; class dictionary; object decomposeParDict; }\nnumberOfSubdomains %s;\nmethod scotch;\n' "$NP" > system/decomposeParDict
  fi
  # the matrix's np wins: a split written for another count (simple's n, say) can't work, so scotch does it
  CUR=$(sed -n -E 's/^numberOfSubdomains[[:space:]]+([0-9]+)[[:space:]]*;.*/\1/p' system/decomposeParDict | head -1)
  if [ "$CUR" != "$NP" ]; then
    edit "s/^(numberOfSubdomains[[:space:]]+)[^;]+;/\1$NP;/; s/^(method[[:space:]]+)[^;]+;/\1scotch;/" system/decomposeParDict
  fi
  if [ $SNAPPY = 0 ]; then fields; fi
  stage decompose
  decomposePar -force > log.decomposePar 2>&1
  if [ $SNAPPY = 1 ]; then
    stage snappyHexMesh
    $MPI snappyHexMesh -parallel -overwrite > log.snappyHexMesh 2>&1
    fields
  fi
  $MPI checkMesh -parallel -constant > log.checkMesh 2>&1 || true
  if [ "${POTENTIAL:-0}" = 1 ]; then
    stage potentialFoam
    $MPI potentialFoam -parallel -writephi > log.potentialFoam 2>&1
  fi
  stage solve
  $MPI "$APP" -parallel > "log.$APP" 2>&1
  stage reconstruct
  if [ $SNAPPY = 1 ]; then reconstructParMesh -constant > log.reconstructParMesh 2>&1; fi
  reconstructPar -latestTime > log.reconstructPar 2>&1
  [ "${KEEP_PROCESSORS:-0}" = 1 ] || rm -rf processor*
else
  if [ $SNAPPY = 1 ]; then
    stage snappyHexMesh
    snappyHexMesh -overwrite > log.snappyHexMesh 2>&1
  fi
  fields
  checkMesh -constant > log.checkMesh 2>&1 || true
  if [ "${POTENTIAL:-0}" = 1 ]; then
    stage potentialFoam
    potentialFoam -writephi > log.potentialFoam 2>&1
  fi
  stage solve
  "$APP" > "log.$APP" 2>&1
fi
stage done
