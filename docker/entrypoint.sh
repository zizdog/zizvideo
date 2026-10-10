#!/bin/sh
# ============================================================================
#  zizvideo 容器入口：用环境变量把配置生成出来（首次），然后 exec 主进程。
#
#  为什么要有它：zizvideo 需要一个 config.json 才能启动，而容器里不该要求用户
#  先手写一份 JSON 再挂进去。这里做到"给几个环境变量就能起来"，并且**已有配置绝不覆盖**
#  （用户改过的东西不能被容器重启冲掉）。
#
#  环境变量：
#    ZV_LISTEN       监听地址        （默认 0.0.0.0:7766）
#    ZV_DATA_DIR     数据目录        （默认 /data；数据库/封面/收件箱都在这）
#    ZV_MEDIA_ROOTS  媒体根，冒号分隔（默认 /media）
#  ============================================================================
set -eu

LISTEN="${ZV_LISTEN:-0.0.0.0:7766}"
DATA_DIR="${ZV_DATA_DIR:-/data}"
MEDIA_ROOTS="${ZV_MEDIA_ROOTS:-/media}"
CONFIG="$DATA_DIR/config.json"

mkdir -p "$DATA_DIR"

if [ ! -f "$CONFIG" ]; then
  echo "==> 首次启动：生成 $CONFIG（listen=$LISTEN，媒体根=$MEDIA_ROOTS）"
  python3 - "$CONFIG" "$LISTEN" "$DATA_DIR" "$MEDIA_ROOTS" <<'PYEOF' 2>/dev/null || \
  printf '{"listen":"%s","data_dir":"%s","database_path":"%s/zizvideo.db","media_allow_roots":["%s"],"allow_register":false}\n' \
    "$LISTEN" "$DATA_DIR" "$DATA_DIR" "$(printf '%s' "$MEDIA_ROOTS" | cut -d: -f1)" >"$CONFIG"
import json, os, sys
cfg_path, listen, data, roots = sys.argv[1], sys.argv[2], sys.argv[3], sys.argv[4]
cfg = {
    "listen": listen,
    "data_dir": data,
    "database_path": os.path.join(data, "zizvideo.db"),
    "media_allow_roots": [r for r in roots.split(":") if r.startswith("/")] or ["/media"],
    "allow_register": False,
}
tmp = cfg_path + ".tmp"
with open(tmp, "w") as handle:
    json.dump(cfg, handle, ensure_ascii=False, indent=2)
    handle.write("\n")
os.replace(tmp, cfg_path)
PYEOF
else
  echo "==> 已有配置，保持不动：$CONFIG"
fi

exec /usr/local/bin/zizvideo --config "$CONFIG"
