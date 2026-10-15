const fs = require("fs");
const { isOwnE2EPersonalDir } = require("./_e2e-personal-dir.js");

// Cleans up the throwaway GCA_PERSONAL temp dir playwright.config.js creates
// for the shared webServer. Best-effort: a leftover temp dir is a minor OS-temp
// hygiene issue, never a real-data risk (it only ever holds sample-derived
// build output, if anything at all).
module.exports = async function globalTeardown() {
  const dir = process.env.GCA_E2E_PERSONAL_DIR;
  // never rmSync a directory this run didn't create.
  if (isOwnE2EPersonalDir(dir)) { try { fs.rmSync(dir, { recursive: true, force: true }); } catch (e) { /* best-effort */ } }
};
