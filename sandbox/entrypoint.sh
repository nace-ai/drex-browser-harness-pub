#!/bin/sh
# E2B command sessions do not inherit Docker ENV from the build steps.
export PLAYWRIGHT_BROWSERS_PATH=/opt/browsers
export NODE_EXTRA_CA_CERTS=/usr/local/share/ca-certificates/e2b-ca.crt
exec node /opt/browser/node_modules/@nace-ai/browser/bin/drex-browser-run.mjs
