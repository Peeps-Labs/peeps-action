#!/bin/bash
# E0 spike driver. Never fails the job on a check: it records ROW lines and a summary.
set -u
SPIKE=$(cd "$(dirname "$0")" && pwd)
WS=${GITHUB_WORKSPACE:-$(cd "$SPIKE/../.." && pwd)}
OUT=/tmp/e0/out; mkdir -p "$OUT"; LOG="$OUT/rows.txt"; : > "$LOG"
row() { echo "ROW $1 $2" | tee -a "$LOG"; }
NODE_DIR=$(dirname "$(dirname "$(readlink -f "$(command -v node)")")")
IP=$(hostname -I | awk '{print $1}'); PORT=18080; SINK="$IP:$PORT"
row image "$(. /etc/os-release; echo "$VERSION_ID") kernel=$(uname -r) systemd=$(systemctl --version | head -1 | awk '{print $2}') util-linux=$(unshare --version | awk '{print $NF}') node=$(node -v)"

# Row 1
sudo -n true && row 1_sudo_n pass || row 1_sudo_n FAIL
row 1_cgroupfs "$(stat -fc %T /sys/fs/cgroup)"
# Row 2 (mode only; the read is in the probe)
row 2_home_runner_mode "$(stat -c '%a %U' /home/runner 2>/dev/null || echo missing)"
row 2_workspace_path "$WS"
# Row 3
row 3_sudoers_use_pty "$(sudo -n grep -rhs use_pty /etc/sudoers /etc/sudoers.d | tr '\n' ';' || true)"
out=$(printf 'a\0b' | sudo -n systemd-run --pipe --wait --collect --quiet od -c 2>&1 | head -1 | tr -s ' ')
case "$out" in *"a \\0 b"*) row 3_stdin_nul_through_sudo_systemd_run pass ;; *) row 3_stdin_nul_through_sudo_systemd_run "FAIL [$out]" ;; esac
t0=$(date +%s.%N); (sleep 1; echo x) | sudo -n systemd-run --pipe --wait --collect --quiet cat > /dev/null 2>&1
row 3_eof_returns_after_s "$(awk -v a="$(date +%s.%N)" -v b="$t0" 'BEGIN{printf "%.2f", a-b}')"
# Row 10
row 10_chrony_makestep "$(grep -hs makestep /etc/chrony/chrony.conf /etc/chrony/conf.d/* | tr '\n' ';')"
row 10_chrony_sources "$(chronyc -n sources 2>&1 | tail -n +3 | head -3 | tr -s ' ' | tr '\n' ';')"
row 10_hv_utils "$(lsmod | grep -c hv_utils) ptp_hyperv=$(lsmod | grep -c ptp_hyperv) timesyncd=$(systemctl is-active systemd-timesyncd)"
row 10_vsock_modules "$(lsmod | grep -E 'vsock|hv_sock' | awk '{print $1}' | tr '\n' ',')"

# Sink, supervisor-side forwarder, socket staging.
python3 "$SPIKE/sink.py" $PORT "$OUT/sink.log" & SINKPID=$!
mkdir -p /tmp/e0; rm -f /tmp/e0/proxy.sock
node "$SPIKE/fwd.js" /tmp/e0/proxy.sock "$IP" $PORT & FWDPID=$!
sleep 1
sudo -n mkdir -p /run/e0sock && sudo -n mv /tmp/e0/proxy.sock /run/e0sock/ \
  && sudo -n chown root:65533 /run/e0sock /run/e0sock/proxy.sock && sudo -n chmod 0710 /run/e0sock && sudo -n chmod 0660 /run/e0sock/proxy.sock \
  && row sock_staged pass || row sock_staged FAIL
echo "$SINK" > "$SPIKE/fixture/sink.txt"

PROPS=(--pipe --wait --collect --quiet --service-type=exec --working-directory=/
  -p KillMode=control-group -p TimeoutStopSec=2s -p RuntimeMaxSec=300s -p MemoryMax=2G -p TasksMax=512
  "-p" "RestrictAddressFamilies=AF_UNIX AF_INET AF_INET6 AF_NETLINK"
  -p SystemCallErrorNumber=EPERM
  "-p" "SystemCallFilter=~@debug bpf keyctl add_key request_key pidfd_getfd setns io_uring_setup io_uring_enter io_uring_register"
  --setenv=WS="$WS" --setenv=NODE_DIR="$NODE_DIR" --setenv=SPIKE="$SPIKE" --setenv=SINK_ADDR="$SINK")
NODE=$(readlink -f "$(command -v node)")

# Rows 2, 6, 7: the probe.
sudo -n systemd-run --unit=e0-probe "${PROPS[@]}" --setenv=E0_LIFELINE=0 "$NODE" "$SPIKE/outer.js" "$SPIKE/init.sh" probe < /dev/null 2>&1 | tee "$OUT/probe.txt" | grep '^ROW' >> "$LOG"
cat "$OUT/probe.txt"; [ -s "$OUT/probe.txt" ] || sudo -n journalctl -u e0-probe --no-pager | tail -20
[ -e "$WS/e0-write-probe" ] && row 7_write_reached_checkout FAIL-yes || row 7_write_reached_checkout pass-no
# Same probe without the family filter, to show what the filter alone buys.
P2=(); for p in "${PROPS[@]}"; do case "$p" in RestrictAddressFamilies=*|SystemCallFilter=*) P2=("${P2[@]:0:${#P2[@]}-1}") ;; *) P2+=("$p") ;; esac; done
sudo -n systemd-run --unit=e0-probe-nofilter "${P2[@]}" --setenv=E0_LIFELINE=0 "$NODE" "$SPIKE/outer.js" "$SPIKE/init.sh" probe < /dev/null 2>&1 \
  | grep -E '^ROW (af_vsock|af_packet|io_uring_setup|bpf) ' | sed 's/^ROW /ROW nofilter_/' | tee -a "$LOG"

# Row 11: overlay install. Pre-claim: npm install --ignore-scripts outside the jail.
(cd "$SPIKE/fixture" && npm install --ignore-scripts --no-audit --no-fund > /dev/null 2>&1) && row 11_preclaim_install pass || row 11_preclaim_install FAIL
for uid in 65534 "$(id -u)"; do
  sudo -n systemd-run --unit=e0-rebuild-$uid "${PROPS[@]}" --setenv=E0_LIFELINE=0 --setenv=EXEC_UID=$uid "$NODE" "$SPIKE/outer.js" "$SPIKE/init.sh" rebuild < /dev/null 2>&1 | tee "$OUT/rebuild-$uid.txt"
  grep '^ROW' "$OUT/rebuild-$uid.txt" >> "$LOG"
  grep -q 'postinstall-ran-as' "$OUT/rebuild-$uid.txt" && row 11_postinstall_ran_uid$uid yes || row 11_postinstall_ran_uid$uid no
done
[ -e "$SPIKE/fixture/node_modules/evil/marker" ] && row 11_marker_in_checkout FAIL-yes || row 11_marker_in_checkout pass-no

# Row 4: teardown. Each case launches a held unit through sup.js, injects a fault, and times the cgroup emptying.
HP=(); for p in "${PROPS[@]}"; do [ "$p" = --quiet ] || HP+=("$p"); done
HOLD_ARGS=$(node -e 'console.log(JSON.stringify(process.argv.slice(1)))' -- "${HP[@]}" --setenv=E0_LIFELINE=1 "$NODE" "$SPIKE/outer.js" "$SPIKE/init.sh" hold)
teardown_case() { # name, fault
  local name=$1 fault=$2 unit=e0-td-$1
  node "$SPIKE/sup.js" "$unit" "$HOLD_ARGS" > "$OUT/td-$name.txt" 2>&1 & local sup=$!
  for i in $(seq 1 40); do grep -q 'INIT hold ready' "$OUT/td-$name.txt" && break; sleep 0.25; done
  local cg; cg=$(systemctl show -p ControlGroup --value "$unit.service")
  [ -z "$cg" ] && tail -5 "$OUT/td-$name.txt"
  local sudopid; sudopid=$(grep -o 'sudo=[0-9]*' "$OUT/td-$name.txt" | cut -d= -f2)
  local initpid; initpid=$(pgrep -f "^/bin/bash .*init.sh hold" | head -1)
  row "4_${name}_before" "active=$(systemctl is-active "$unit.service") cg=$cg procs=$(cat /sys/fs/cgroup$cg/cgroup.procs 2>/dev/null | wc -l)"
  case "$fault" in
    kill_sup) kill -9 "$sup" ;;
    kill_sudo) sudo -n kill -9 "$sudopid" ;;
    stop_init_kill_sup) sudo -n kill -STOP "$initpid"; sleep 0.5; kill -9 "$sup" ;;
  esac
  local t0; t0=$(date +%s.%N); local gone=no
  for i in $(seq 1 60); do
    if [ ! -e "/sys/fs/cgroup$cg/cgroup.events" ] || grep -q 'populated 0' "/sys/fs/cgroup$cg/cgroup.events"; then gone=yes; break; fi
    sleep 0.25
  done
  local dt; dt=$(awk -v a="$(date +%s.%N)" -v b="$t0" 'BEGIN{printf "%.2f", a-b}')
  [ -n "$cg" ] && [ "$gone" = yes ] && awk -v d="$dt" 'BEGIN{exit !(d<5)}' && row "4_${name}" "pass ${dt}s" || row "4_${name}" "FAIL gone=$gone ${dt}s"
  pgrep -f 'sleep 900' > /dev/null && row "4_${name}_descendant" FAIL-alive || row "4_${name}_descendant" pass-gone
  sudo -n systemctl stop "$unit.service" > /dev/null 2>&1; sudo -n pkill -f 'sleep 900'; wait "$sup" 2>/dev/null
}
teardown_case sup_killed kill_sup
teardown_case sudo_killed kill_sudo
teardown_case init_stopped stop_init_kill_sup

# Sink: anything but the relay's positive control is an escape.
sleep 1
row sink_relay_hits "$(grep -c 'via-relay' "$OUT/sink.log")"
row sink_other_hits "$(grep -vc 'via-relay' "$OUT/sink.log")"
grep -v 'via-relay' "$OUT/sink.log" | head -5
kill $SINKPID $FWDPID 2>/dev/null

{ echo "### E0 rows ($(. /etc/os-release; echo "$VERSION_ID"))"; echo; echo '| row | value |'; echo '|---|---|'
  sed -E 's/^ROW ([^ ]+) (.*)$/| \1 | \2 |/' "$LOG"; } >> "${GITHUB_STEP_SUMMARY:-/dev/stdout}"
echo "== ROWS =="; cat "$LOG"
exit 0
