/*
 * Test-only preload for a spawned server (node --require <this file>): makes
 * fs.rmSync / fs.renameSync fail with EBUSY for the paths a regex names, as a
 * folder Explorer has open or a file antivirus is scanning would on Windows.
 *   GCA_TEST_BUSY_RM=<regex>      rmSync of an existing path that matches
 *   GCA_TEST_BUSY_RENAME=<regex>  renameSync whose source path matches
 *   GCA_TEST_BUSY_COPY=<regex>    copyFile / copyFileSync whose source matches
 * Only the server process loads it; the build it spawns is unaffected.
 */
"use strict";
const fs = require("fs");

const busy = (p) => Object.assign(new Error("EBUSY: resource busy or locked, '" + p + "'"), { code: "EBUSY", path: String(p) });
const re = (v) => (v ? new RegExp(v) : null);
const rmRe = re(process.env.GCA_TEST_BUSY_RM), renameRe = re(process.env.GCA_TEST_BUSY_RENAME), copyRe = re(process.env.GCA_TEST_BUSY_COPY);
if (rmRe) {
  const real = fs.rmSync;
  fs.rmSync = function (p, opts) {
    if (rmRe.test(String(p)) && fs.existsSync(p)) throw busy(p);
    return real.call(fs, p, opts);
  };
}
if (renameRe) {
  const real = fs.renameSync;
  fs.renameSync = function (a, b) {
    if (renameRe.test(String(a))) throw busy(a);
    return real.call(fs, a, b);
  };
}
if (copyRe) {
  const realSync = fs.copyFileSync, realAsync = fs.promises.copyFile;
  fs.copyFileSync = function (a, ...rest) {
    if (copyRe.test(String(a))) throw busy(a);
    return realSync.call(fs, a, ...rest);
  };
  fs.promises.copyFile = function (a, ...rest) {
    if (copyRe.test(String(a))) return Promise.reject(busy(a));
    return realAsync.call(fs.promises, a, ...rest);
  };
}
