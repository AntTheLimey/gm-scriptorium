'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const { withScratch, run, SAMPLE } = require('./helpers/b4-cli');
const { moveVaultCopy } = require('./helpers/moved-vault');

/*
 * The CLI on a vault whose settings are in _meta/vault-config.yaml (moved), or that holds both
 * files (mixed). Before this version these exited 3 with a refusal (issue #171); that rule is gone
 * on purpose. `check` and `build` now read the yaml. SCRIPTORIUM_TEST_BIN runs this same file
 * against the packaged binary.
 */

function register(root, vault, siteConfig) {
  const site = siteConfig ? `site_config = '${siteConfig}'\n` : '';
  fs.writeFileSync(path.join(root, 'config.toml'), `config_version = 1\n[campaigns.t]\nvault = '${vault}'\n${site}output = '${path.join(root, 'site')}'\n`);
}

/** A moved copy of the sample (its pack kept), registered as campaign "t". */
function moved(root) {
  const { vaultPath } = moveVaultCopy(SAMPLE, root);
  register(root, vaultPath);
  return vaultPath;
}

/**
 * A moved copy of the sample whose pack settings the move already carried into the yaml (the
 * site title, folder map and hide lists are in vault-config.yaml), registered with the site file
 * the move left behind.
 */
function carried(root) {
  const pack = JSON.parse(fs.readFileSync(path.join(SAMPLE, '_meta', 'scriptorium', 'vault.config.json'), 'utf8'));
  const { vaultPath, siteConfig } = moveVaultCopy(SAMPLE, root, { siteConfig: pack });
  const left = path.join(root, 'site-left.json');
  fs.writeFileSync(left, JSON.stringify(siteConfig, null, 2));
  fs.rmSync(path.join(vaultPath, '_meta', 'scriptorium'), { recursive: true, force: true });
  register(root, vaultPath, left);
  return vaultPath;
}

/** Add one entry to the pack's excludeSections, which the yaml does not hold. */
function addUncarriedHide(vault, entry) {
  const file = path.join(vault, '_meta', 'scriptorium', 'vault.config.json');
  const json = JSON.parse(fs.readFileSync(file, 'utf8'));
  json.excludeSections.push(entry);
  fs.writeFileSync(file, JSON.stringify(json, null, 2));
}

test('check on a moved vault exits 0', () => {
  withScratch((root) => {
    moved(root);
    const res = run(root, ['check']);
    assert.equal(res.code, 0, res.all);
  });
});

test('build on a moved vault exits 0 and builds the title the yaml holds', () => {
  withScratch((root) => {
    carried(root);
    const res = run(root, ['build']);
    assert.equal(res.code, 0, res.all);
    assert.match(fs.readFileSync(path.join(root, 'site', 'index.html'), 'utf8'), /The Long Lease/);
  });
});

test('check and build on a mixed vault exit 0, and the left over file is reported', () => {
  withScratch((root) => {
    const vault = carried(root);
    fs.copyFileSync(path.join(SAMPLE, '_meta', 'vault-config.md'), path.join(vault, '_meta', 'vault-config.md'));
    const checked = run(root, ['check']);
    assert.equal(checked.code, 0, checked.all);
    assert.match(checked.all, /left over/);
    const built = run(root, ['build']);
    assert.equal(built.code, 0, built.all);
    // The build repeats the generator's own warning line.
    assert.match(built.all, /_meta\/vault-config\.md is left over from before the update and is not read/);
  });
});

test('a pack hide entry the yaml lacks gives check exit 2, and build exit 2 with the output folder untouched', () => {
  withScratch((root) => {
    const vault = moved(root);
    addUncarriedHide(vault, 'Secret Plans');
    const checked = run(root, ['check']);
    assert.equal(checked.code, 2, checked.all);
    assert.match(checked.all, /config\/pack-hiding-not-carried/);
    assert.match(checked.all, /Run "gm-scriptorium carry t" to move it into the vault's settings\./);
    const built = run(root, ['build']);
    assert.equal(built.code, 2, built.all);
    assert.equal(fs.existsSync(path.join(root, 'site')), false);
    assert.deepEqual(fs.readdirSync(root).filter((n) => n.startsWith('.scriptorium-')), []);
  });
});

test('build --force-check builds past the uncarried hide entry', () => {
  withScratch((root) => {
    const vault = moved(root);
    addUncarriedHide(vault, 'Secret Plans');
    const res = run(root, ['build', '--force-check']);
    assert.equal(res.code, 0, res.all);
    assert.equal(fs.existsSync(path.join(root, 'site', 'index.html')), true);
  });
});

test('a pack siteTitle that differs from the yaml gives check exit 0 with the warning', () => {
  withScratch((root) => {
    const vault = moved(root);
    const file = path.join(vault, '_meta', 'scriptorium', 'vault.config.json');
    const json = JSON.parse(fs.readFileSync(file, 'utf8'));
    json.siteTitle = 'A Different Title';
    fs.writeFileSync(file, JSON.stringify(json, null, 2));
    const res = run(root, ['check']);
    assert.equal(res.code, 0, res.all);
    assert.match(res.all, /config\/pack-setting-differs/);
  });
});

test('a malformed vault-config.yaml gives check exit 2 naming the file, with no stack trace', () => {
  withScratch((root) => {
    const vault = moved(root);
    fs.writeFileSync(path.join(vault, '_meta', 'vault-config.yaml'), 'type: meta\nplayer_site:\n  hide:\n    sections: [unclosed\n');
    const res = run(root, ['check']);
    assert.equal(res.code, 2, res.all);
    assert.match(res.all, /vault-config\.yaml/);
    assert.doesNotMatch(res.all, /\n\s+at .*\(.*:\d+:\d+\)/);
  });
});

test('build on a malformed vault-config.yaml gives exit 2 at the check step and writes no output', () => {
  withScratch((root) => {
    const vault = moved(root);
    fs.writeFileSync(path.join(vault, '_meta', 'vault-config.yaml'), 'type: meta\nplayer_site:\n  hide:\n    sections: [unclosed\n');
    const res = run(root, ['build']);
    assert.equal(res.code, 2, res.all);
    assert.equal(fs.existsSync(path.join(root, 'site')), false);
  });
});

test('status and config list call a moved vault reachable, not unreachable (settings-moved)', () => {
  withScratch((root) => {
    moved(root);
    const status = run(root, ['status']);
    assert.equal(status.code, 0, status.all);
    assert.match(status.out, /^t: reachable \(/m);
    assert.doesNotMatch(status.all, /unreachable|settings-moved/);
    const list = run(root, ['config', 'list']);
    assert.equal(list.code, 0, list.all);
    assert.match(list.out, /\[reachable\]/);
    assert.doesNotMatch(list.all, /unreachable|settings-moved/);
  });
});
