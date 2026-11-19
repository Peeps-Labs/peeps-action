#!/bin/bash
# Jail init: pid 1 in fresh net/pid/mount/ipc/uts namespaces, root until it drops.
# Builds a minimal root (plan v3 §3 isolate), then runs one mode.
set -u
mode=$1
R=/run/e0root-$$-$RANDOM
row() { echo "ROW $1 $2"; }
bindro() { mount --bind "$1" "$2" && mount -o remount,bind,ro,nosuid,nodev "$2"; }

mount --make-rprivate /
mkdir -p "$R" && mount -t tmpfs -o mode=755 tmpfs "$R"
mkdir -p "$R"/{usr,etc,dev,proc,tmp,oldroot} "$R"/run/peeps/{ws-lower,ws,node,spike,home,up,sock}

# 1. Stage inputs first (masking /home first would hide them).
bindro "$WS" "$R/run/peeps/ws-lower" || row stage_ws FAIL
bindro "$NODE_DIR" "$R/run/peeps/node" || row stage_node FAIL
bindro "$SPIKE" "$R/run/peeps/spike" || row stage_spike FAIL
[ -d /run/e0sock ] && mount --bind /run/e0sock "$R/run/peeps/sock"

# 2. Minimal system.
bindro /usr "$R/usr"
for l in bin sbin lib lib64 lib32 libx32; do
  if [ -L "/$l" ]; then ln -s "$(readlink "/$l")" "$R/$l"
  elif [ -d "/$l" ]; then mkdir "$R/$l"; bindro "/$l" "$R/$l"; fi
done
for d in ssl alternatives; do mkdir -p "$R/etc/$d"; bindro "/etc/$d" "$R/etc/$d"; done
for f in ld.so.cache passwd group nsswitch.conf hosts; do [ -e "/etc/$f" ] && touch "$R/etc/$f" && bindro "/etc/$f" "$R/etc/$f"; done
mount -t tmpfs -o mode=755,nosuid tmpfs "$R/dev"
for n in null zero urandom random tty; do touch "$R/dev/$n"; mount --bind "/dev/$n" "$R/dev/$n"; done
mount -t tmpfs -o mode=1777,nosuid,nodev tmpfs "$R/tmp"
mount -t tmpfs -o mode=1777,nosuid,nodev tmpfs "$R/run/peeps/home"

# 3. Workspace overlay, upper on a capped tmpfs.
mount -t tmpfs -o size=512m,mode=755 tmpfs "$R/run/peeps/up" && mkdir "$R/run/peeps/up/u" "$R/run/peeps/up/w"
if mount -t overlay overlay -o "lowerdir=$R/run/peeps/ws-lower,upperdir=$R/run/peeps/up/u,workdir=$R/run/peeps/up/w" "$R/run/peeps/ws"; then
  row overlay pass; else row overlay FAIL; fi

# 4. Loopback, pivot, fresh /proc.
{ command -v ip >/dev/null && ip link set lo up; }  && row lo_up pass || row lo_up FAIL
cd "$R" && pivot_root . oldroot && cd / && mount -t proc -o nosuid,nodev,noexec proc /proc \
  && umount -l /oldroot && rmdir /oldroot && row pivot pass || { row pivot FAIL; exit 1; }

drop() { # uid, then command
  local u=$1; shift
  setpriv --reuid "$u" --regid "$u" --clear-groups --bounding-set=-all --inh-caps=-all --ambient-caps=-all --no-new-privs \
    env -i PATH=/run/peeps/node/bin:/usr/bin:/bin HOME=/run/peeps/home SINK_ADDR="${SINK_ADDR:-}" "$@"
}
N=/run/peeps/node/bin/node

case "$mode" in
  probe)
    row sockdir "$(stat -c '%a:%U:%G' /run/peeps/sock /run/peeps/sock/proxy.sock 2>&1 | tr '\n' ' ')"
    drop 65533 $N /run/peeps/spike/relay.js &
    sleep 1
    cd /run/peeps/ws && drop 65534 bash /run/peeps/spike/probe.sh
    ;;
  hold)
    setsid sleep 900 < /dev/null > /dev/null 2>&1 &
    echo "INIT hold ready"
    sleep 900
    ;;
  rebuild)
    cd /run/peeps/ws/spike/e0/fixture && drop "${EXEC_UID:-65534}" npm rebuild --foreground-scripts 2>&1 | tail -15
    [ -e node_modules/evil/marker ] && row "rebuild_marker_in_overlay_uid${EXEC_UID:-65534}" yes || row "rebuild_marker_in_overlay_uid${EXEC_UID:-65534}" no
    ;;
esac
exit 0
