#!/bin/bash
# usage: livepoll.sh RUNID OFFSETFILE  — waits until new sections appear (max ~9 min), prints new text
RID=$1; OFF=$2; [ -f $OFF ] || echo 0 > $OFF
for i in $(seq 1 18); do
  c=$(gh api "repos/stav26177790-glitch/sales-closer-backend/contents/live/$RID/${SIT:-25}.md?ref=eval-live" -q .content 2>/dev/null | base64 -d 2>/dev/null)
  st=$(gh run view $RID -R stav26177790-glitch/sales-closer-backend --json status -q .status)
  len=${#c}; o=$(cat $OFF)
  if [ "$len" -gt "$o" ]; then echo "${c:$o}"; echo $len > $OFF; exit 0; fi
  [ "$st" = "completed" ] && { echo "__DONE__"; exit 0; }
  sleep 30
done
echo "__WAIT__"
