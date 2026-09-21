#!/usr/bin/env bash
set -e
npm install
npx cap add android
npx cap sync android
npx cap open android
