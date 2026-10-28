'use strict';

/*
 * Test-only helper: a copy of a vault that gm-apprentice's own move has already run on, so a test
 * can read a vault whose settings live in _meta/vault-config.yaml.
 *
 * It requires the pin's lib/settings/move directly, which src/ never does (product code reaches the
 * pin only through src/generator/pinned.js). This is test-only tooling, the same exception
 * scripts/equivalence-check.js documents. The move is the pin's own planMove/applyMove, so the
 * copy is what the real tool makes, not a hand-built imitation.
 */

const fs = require('fs');
const path = require('path');
// Loaded first, for its side effect: the facade seeds the generator's redactions before the pin's
// template tree loads, and loading the pin's move below would otherwise load that tree too early.
require('../../src/generator/pinned');
const { planMove, applyMove } = require('gm-apprentice-publish/lib/settings/move');

/**
 * Copy `srcVault` into `root`, optionally with a site config beside it, and run the pin's move on
 * the copy (folding the site file's settings in when one is given).
 *
 * @param {string} srcVault the vault folder to copy
 * @param {string} root an existing scratch folder to copy into
 * @param {{ siteConfig?: object }} [opts] a site config (vault.config.json content) to fold in
 * @returns {{ vaultPath: string, siteConfig: object|undefined }} the moved copy, and the site
 *   config as the move left it (its settings taken out), with `vaultPath` removed; undefined when
 *   none was given
 * @throws {Error} when the pin's plan is not ok
 */
function moveVaultCopy(srcVault, root, { siteConfig } = {}) {
  const copy = path.join(root, 'vault');
  fs.cpSync(srcVault, copy, { recursive: true });
  const vaultPath = fs.realpathSync.native(copy);
  let siteConfigPath;
  if (siteConfig) {
    const siteDir = path.join(root, 'site');
    fs.mkdirSync(siteDir, { recursive: true });
    siteConfigPath = path.join(siteDir, 'vault.config.json');
    fs.writeFileSync(siteConfigPath, JSON.stringify({ ...siteConfig, vaultPath }, null, 2));
  }
  const plan = planMove({ vaultPath, siteConfigPath, foldSiteFile: true });
  if (!plan.ok) throw new Error(`the move was not ok: ${(plan.blockers || []).join('; ')}`);
  applyMove(plan);
  let left;
  if (siteConfigPath) {
    left = JSON.parse(fs.readFileSync(siteConfigPath, 'utf8'));
    delete left.vaultPath;
  }
  return { vaultPath, siteConfig: left };
}

module.exports = { moveVaultCopy };
