#!/bin/sh
set -eu

job_data_root="${JOB_DATA_ROOT:-/data/jobs}"
install -d -o node -g node -m 0700 "$job_data_root"

exec gosu node "$@"
