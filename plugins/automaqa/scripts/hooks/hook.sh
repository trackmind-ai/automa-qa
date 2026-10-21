#!/usr/bin/env bash
# SPDX-FileCopyrightText: 2026 Trackmind
# SPDX-License-Identifier: MIT
#
# Launcher for the AutomaQA hook notifier. hooks/hooks.json calls this script by its
# ${CLAUDE_PLUGIN_ROOT} path; it hands the tool payload on stdin and the pre/post
# argument to hook.js, which decides whether anything is worth printing.
#
# The hooks are informational only: without Node.js this exits 0 and prints nothing.
command -v node > /dev/null 2>&1 || exit 0
exec node "$(dirname "${BASH_SOURCE[0]}")/hook.js" "$@"
