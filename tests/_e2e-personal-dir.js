const fs = require("fs");
const os = require("os");
const path = require("path");

// The e2e run's throwaway GCA_PERSONAL. playwright.config.js creates it and
// globalTeardown rmSync's it, and both only ever trust a directory that looks
// exactly like one this module created: a DIRECT child of os.tmpdir() whose
// name starts with PREFIX. Anything else inherited through
// GCA_E2E_PERSONAL_DIR (a stray export, a typo, a real archive folder) is
// ignored by the config and never deleted by the teardown.
const PREFIX = "gca-e2e-personal-";

function isOwnE2EPersonalDir(dir) {
  if (typeof dir !== "string" || !dir) return false;
  const rel = path.relative(path.resolve(os.tmpdir()), path.resolve(dir));
  if (!rel || path.isAbsolute(rel) || rel.includes(path.sep) || rel.includes("/")) return false;
  return rel.startsWith(PREFIX) && rel.length > PREFIX.length;
}

// Workers re-evaluate playwright.config.js, so the FIRST evaluation (the test
// runner's own process) creates the dir and exports it; each worker inherits
// the env var and reuses it — but only if it passes isOwnE2EPersonalDir().
function ensureE2EPersonalDir() {
  const inherited = process.env.GCA_E2E_PERSONAL_DIR;
  if (isOwnE2EPersonalDir(inherited)) return inherited;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), PREFIX));
  process.env.GCA_E2E_PERSONAL_DIR = dir;
  return dir;
}

module.exports = { PREFIX, isOwnE2EPersonalDir, ensureE2EPersonalDir };
