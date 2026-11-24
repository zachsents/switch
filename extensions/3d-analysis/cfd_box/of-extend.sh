#!/bin/bash
# Runs a finished case on from its latest time to END, in the case folder it runs in.
#   of-extend.sh END [continue|restart]
# continue: field averages carry on over the whole run; restart: they start again at this restart, so
# they cover the extension alone. Running on to END means to END: SIMPLE's residualControl, which would
# stop it again at its first step, comes off, and the write schedule becomes one write at END (runTime, or
# the case's adjustableRunTime), so its last step is kept whatever the case's own interval was. Its solver
# log is log.<solver>.ext<N>. Top-level dictionary entries are the unindented ones, as OpenFOAM writes them.
#   env: NP (ranks, default 1), CFD_STAGES, KEEP_PROCESSORS
set -Eeo pipefail
trap 'echo "of-extend.sh line $LINENO: \"$BASH_COMMAND\" exited $?" >&2' ERR
shopt -s nullglob
END=$1; AVG=${2:-continue}; NP=${NP:-1}
[ -n "$END" ] || { echo "usage: of-extend.sh END [continue|restart]"; exit 2; }
STAGES=${CFD_STAGES:-log.stages}
stage() { echo "$(date +%T) $1" >> "$STAGES"; }
edit() { sed -E "$1" "$2" > "$2.cfd-tmp" && mv "$2.cfd-tmp" "$2"; }  # sed -i differs between GNU and BSD
APP=$(sed -n -E 's/^[[:space:]]*application[[:space:]]+([A-Za-z0-9_]+)[[:space:]]*;.*/\1/p' system/controlDict | head -1)
[ -n "$APP" ] || { echo "system/controlDict names no application"; exit 2; }
MPI="mpirun --allow-run-as-root --oversubscribe --bind-to none -np $NP"
TIMES=()
for d in [0-9]*; do
  if [[ -d "$d" && "$d" =~ ^[0-9.eE+-]+$ ]]; then TIMES+=("$d"); fi
done
LAST=$(printf '%s\n' "${TIMES[@]}" | sort -g | tail -1)
[ -n "$LAST" ] && [ "$LAST" != 0 ] || { echo "no time to run on from (reconstructed time folders are gone)"; exit 2; }
EXTS=(log."$APP".ext*)
N=$(( ${#EXTS[@]} + 1 ))
stage "extend from $LAST to $END ($AVG averages)"
WC=$(sed -n -E 's/^writeControl[[:space:]]+([A-Za-z]+)[[:space:]]*;.*/\1/p' system/controlDict | head -1)
[ "$WC" = adjustableRunTime ] || WC=runTime
SPAN=$(awk -v a="$END" -v b="$LAST" 'BEGIN { printf "%g", a - b }')
edit "s/^(endTime[[:space:]]+)[^;]+;/\1$END;/; s/^(startFrom[[:space:]]+)[^;]+;/\1latestTime;/; s/^(writeControl[[:space:]]+)[^;]+;/\1$WC;/; s/^(writeInterval[[:space:]]+)[^;]+;/\1$SPAN;/" system/controlDict
if [ -f system/fvSolution ] && foamDictionary -entry SIMPLE/residualControl system/fvSolution > /dev/null 2>&1; then
  foamDictionary -entry SIMPLE/residualControl -remove system/fvSolution > /dev/null
  stage "residualControl off"
fi
if [ "$AVG" = restart ]; then
  for fo in $(foamDictionary -disableFunctionEntries -entry functions -keywords system/controlDict 2>/dev/null); do
    t=$(foamDictionary -disableFunctionEntries -entry "functions/$fo/type" -value system/controlDict 2>/dev/null || true)
    if [ "$t" = fieldAverage ]; then
      foamDictionary -disableFunctionEntries -entry "functions/$fo/restartOnRestart" -set true system/controlDict > /dev/null
    fi
  done
fi
if [ "$NP" -gt 1 ]; then
  # the matrix's np wins: a split written for another count (simple's n, say) can't work, so scotch does it
  CUR=$(sed -n -E 's/^numberOfSubdomains[[:space:]]+([0-9]+)[[:space:]]*;.*/\1/p' system/decomposeParDict | head -1)
  if [ "$CUR" != "$NP" ]; then
    edit "s/^(numberOfSubdomains[[:space:]]+)[^;]+;/\1$NP;/; s/^(method[[:space:]]+)[^;]+;/\1scotch;/" system/decomposeParDict
  fi
  rm -rf processor*
  stage decompose
  decomposePar -force -latestTime > "log.decomposePar.ext$N" 2>&1
  stage solve
  $MPI "$APP" -parallel > "log.$APP.ext$N" 2>&1
  stage reconstruct
  reconstructPar -latestTime > "log.reconstructPar.ext$N" 2>&1
  [ "${KEEP_PROCESSORS:-0}" = 1 ] || rm -rf processor*
else
  stage solve
  "$APP" > "log.$APP.ext$N" 2>&1
fi
stage done
