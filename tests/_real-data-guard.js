"use strict";
/*
 * tests/_real-data-guard.js — the clean-checkout rule enforced by code, not memory.
 *
 * PROJECT HARD RULE: real private group-chat data lives under a "personal_data"
 * (or "exports") directory at the repo root (plus a legacy root
 * data.js/names.local.js), and must never be read, listed, tested against, or
 * previewed. Every node:test
 * file that spawns scripts/server.js or otherwise touches the filesystem near
 * the repo root requires this module FIRST (before any other require), so an
 * accidental run from the wrong checkout aborts immediately and loudly instead
 * of quietly loading real messages into a test process.
 *
 * Existence checks ONLY — fs.existsSync()/fs.readdirSync() to list names, never
 * fs.readFileSync() on anything this guard is checking for. Reading the
 * forbidden files is exactly what this module exists to prevent.
 */
const fs = require("fs");
const path = require("path");

const ROOT = path.resolve(__dirname, "..");

function findRealDataHazards(root) {
  const hazards = [];
  let entries;
  try { entries = fs.readdirSync(root, { withFileTypes: true }); } catch (e) { return hazards; }
  for (const e of entries) {
    if (e.isDirectory() && /^(personal_data|exports)/.test(e.name)) hazards.push(e.name + "/");
  }
  for (const name of ["data.js", "names.local.js"]) {
    if (fs.existsSync(path.join(root, name))) hazards.push(name);
  }
  return hazards;
}

const hazards = findRealDataHazards(ROOT);
if (hazards.length) {
  throw new Error(
    "REFUSING TO RUN TESTS: this checkout (" + ROOT + ") contains real-data " +
    "hazard(s): " + hazards.join(", ") + ". Tests must only run from a clean " +
    "worktree with no personal_data*/, exports/, root data.js or names.local.js. " +
    "See \"Privacy & security\" in README.md and docs/SECURITY.md: real " +
    "messages must never reach a test run."
  );
}

module.exports = { findRealDataHazards, ROOT };
