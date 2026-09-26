// QA-2/SP-16: the project's hard rule ("real private data is sacred") used to
// live only in memory/docs. Requiring _real-data-guard.js here makes it
// impossible-by-construction to run the e2e suite from a checkout that
// contains personal_data*/, exports/, a root data.js or a root names.local.js
// — the guard throws (existence checks only, never a read of the forbidden
// files) at require() time, before Playwright's webServer is ever spawned.
require("./_real-data-guard.js");

module.exports = async function globalSetup() {
  // Nothing else to do: reaching this line means _real-data-guard.js's
  // top-level check already passed.
};
