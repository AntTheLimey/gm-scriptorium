'use strict';

/*
 * What `check` says about a pack's leftover settings on a vault whose settings moved to
 * _meta/vault-config.yaml (rung 3b). Each test runs at module level on a copy of the sample vault
 * that the pin's own move has already run on: contextFromSite builds the context, runChecks runs
 * the enabled checks. The command itself is driven in test/vault-settings-moved-cli.test.js; here
 * "check exits 2" is asserted as a finding of severity error.
 *
 * Expected values are typed by hand from the sample vault's yaml after the move and from the pin's
 * rules, never read from the code under test.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { contextFromSite } = require('../src/cli/check');
const { buildCheckContext } = require('../src/checks/context');
const { runChecks } = require('../src/checks/run');
const carry = require('../src/checks/carry');
const { isHeldByVault } = carry;
const { runExcludeSectionsDivergence, runExcludeDirsDivergence, runExcludeFieldsDivergence, runSettingsFault } = require('../src/checks/configdiv');
const pinned = require('../src/generator/pinned');
const { moveVaultCopy } = require('./helpers/moved-vault');

const SAMPLE = path.join(__dirname, '..', 'examples', 'the-long-lease');
const CARRY_IDS = ['config/pack-hiding-not-carried', 'config/pack-setting-not-carried', 'config/pack-setting-differs'];
// The context is built with the campaign name 'x'.
const CARRY_HINT = 'Run "gm-scriptorium carry x" to move it into the vault\'s settings.';

function writePack(root, pack) {
  const dir = path.join(root, 'pack');
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, 'vault.config.json');
  fs.writeFileSync(file, JSON.stringify(pack, null, 2));
  return file;
}

function contextOf(vault, root, pack) {
  const siteConfigPath = writePack(root, pack);
  const site = { siteSource: 'site_config', siteConfigPath, siteDir: path.dirname(siteConfigPath), packShadowed: null };
  const info = contextFromSite({ campaign: 'x', vault, site_config: siteConfigPath }, vault, site);
  return buildCheckContext({
    campaign: 'x',
    vaultPath: info.vaultPath,
    jsonConfig: info.jsonConfig,
    rawSiteConfig: info.rawSiteConfig,
    settingsLayout: info.settingsLayout,
  });
}

function findingsFor(pack, { before } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'scriptorium-carry-'));
  try {
    const { vaultPath } = moveVaultCopy(SAMPLE, root);
    if (before) before(vaultPath);
    const ctx = contextOf(vaultPath, root, pack);
    return { ctx, findings: runChecks(ctx) };
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

const carryOf = (findings) => findings.filter((f) => CARRY_IDS.includes(f.id));

test('a hide entry the pack holds and the yaml lacks is one error finding, and no settings-fault repeats it', () => {
  const { findings } = findingsFor({
    searchEnabled: true,
    excludeSections: ['GM Notes', 'DM Notes', 'Player Notes', 'Source References', 'Reconciliation Context', 'Handoff to Reconcile', 'Pack Only Secret'],
  });
  const found = findings.filter((f) => f.id === 'config/pack-hiding-not-carried');
  assert.equal(found.length, 1);
  assert.equal(found[0].severity, 'error');
  assert.equal(found[0].category, 'config');
  assert.deepEqual(found[0].data, { packKey: 'excludeSections', setting: 'player_site.hide.sections', entries: ['Pack Only Secret'] });
  assert.ok(found[0].message.includes('Pack Only Secret'));
  assert.ok(found[0].message.endsWith(CARRY_HINT), found[0].message);
  assert.equal(findings.filter((f) => f.id === 'config/settings-fault').length, 0);
});

test('the same hide list in another order, and a list the yaml already covers, give no finding', () => {
  const { findings } = findingsFor({
    searchEnabled: true,
    excludeSections: ['Handoff to Reconcile', 'GM Notes', 'Reconciliation Context', 'DM Notes', 'Source References', 'Player Notes'],
  });
  assert.deepEqual(carryOf(findings), []);
  assert.equal(findings.filter((f) => f.id === 'config/settings-fault').length, 0);
});

test('a pack folder the yaml lacks is an error, and one the yaml has under another spelling is held', () => {
  const lacking = findingsFor({ searchEnabled: true, excludeDirs: ['_meta', 'Pack Folder/'] }).findings;
  const found = lacking.filter((f) => f.id === 'config/pack-hiding-not-carried');
  assert.equal(found.length, 1);
  assert.equal(found[0].severity, 'error');
  assert.deepEqual(found[0].data.entries, ['Pack Folder/']);
  assert.equal(found[0].data.setting, 'player_site.hide.folders');

  const spelt = findingsFor({ searchEnabled: true, excludeDirs: ['./_meta/', '_Templates'] }).findings;
  assert.deepEqual(carryOf(spelt), []);
});

test('a pack title unlike the yaml title is one warning that says the vault value is used', () => {
  const { findings } = findingsFor(
    { searchEnabled: true, siteTitle: 'Pack Title' },
    { before: (vault) => {
      const file = path.join(vault, '_meta', 'vault-config.yaml');
      fs.writeFileSync(file, fs.readFileSync(file, 'utf8').replace('player_site:\n', 'player_site:\n  title: "The Long Lease"\n'));
    } },
  );
  const found = carryOf(findings);
  assert.equal(found.length, 1);
  assert.equal(found[0].id, 'config/pack-setting-differs');
  assert.equal(found[0].severity, 'warn');
  assert.deepEqual(found[0].data, { packKey: 'siteTitle', setting: 'player_site.title' });
  assert.ok(found[0].message.includes('The Long Lease'), found[0].message);
  assert.ok(found[0].message.includes('Pack Title'), found[0].message);
  assert.ok(found[0].message.endsWith(CARRY_HINT), found[0].message);
});

test('a pack folder map when the yaml has none is one not-carried warning', () => {
  const { findings } = findingsFor({ searchEnabled: true, folderMap: { Places: 'places' } });
  const found = carryOf(findings);
  assert.equal(found.length, 1);
  assert.equal(found[0].id, 'config/pack-setting-not-carried');
  assert.equal(found[0].severity, 'warn');
  assert.deepEqual(found[0].data, { packKey: 'folderMap', setting: 'player_site.folder_map' });
  assert.ok(found[0].message.endsWith(CARRY_HINT), found[0].message);
});

test('landingTagline in the pack is never reported, because the pin no longer reads it', () => {
  const { findings } = findingsFor({ searchEnabled: true, landingTagline: 'A tagline nobody reads' });
  assert.deepEqual(carryOf(findings), []);
});

test('excludeCallouts less strict than the vault\'s is held, and a stricter one is an error', () => {
  const held = findingsFor({ searchEnabled: true, excludeCallouts: false }).findings;
  assert.deepEqual(carryOf(held), []);
  const lax = findingsFor({ searchEnabled: true, excludeCallouts: ['spoiler'] }, {
    before: (vault) => {
      const file = path.join(vault, '_meta', 'vault-config.yaml');
      fs.writeFileSync(file, fs.readFileSync(file, 'utf8').replace('    mode: player\n', '    mode: player\n    callouts: true\n'));
    },
  }).findings;
  assert.deepEqual(carryOf(lax), []);
  const strict = findingsFor({ searchEnabled: true, excludeCallouts: true }, {
    before: (vault) => {
      const file = path.join(vault, '_meta', 'vault-config.yaml');
      fs.writeFileSync(file, fs.readFileSync(file, 'utf8').replace('    mode: player\n', '    mode: player\n    callouts: false\n'));
    },
  }).findings;
  const found = strict.filter((f) => f.id === 'config/pack-hiding-not-carried');
  assert.equal(found.length, 1);
  assert.equal(found[0].severity, 'error');
  assert.equal(found[0].data.packKey, 'excludeCallouts');
});

test('a legacy-layout vault gets none of the three ids', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'scriptorium-carry-'));
  try {
    const pack = { searchEnabled: true, excludeDirs: ['_meta', 'Pack Folder'], folderMap: { Locations: 'locations' }, excludeSections: ['Pack Only Secret'], siteTitle: 'Pack Title' };
    const siteConfigPath = writePack(root, pack);
    const site = { siteSource: 'site_config', siteConfigPath, siteDir: path.dirname(siteConfigPath), packShadowed: null };
    const info = contextFromSite({ campaign: 'x', vault: SAMPLE, site_config: siteConfigPath }, SAMPLE, site);
    assert.equal(info.settingsLayout, 'legacy');
    const ctx = buildCheckContext({ campaign: 'x', vaultPath: SAMPLE, jsonConfig: info.jsonConfig, rawSiteConfig: info.rawSiteConfig, settingsLayout: info.settingsLayout });
    assert.deepEqual(carryOf(runChecks(ctx)), []);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('a yaml the pin cannot parse is one settings-fault error naming the file, and the carry checks add nothing', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'scriptorium-carry-'));
  try {
    const { vaultPath } = moveVaultCopy(SAMPLE, root);
    const file = path.join(vaultPath, '_meta', 'vault-config.yaml');
    fs.writeFileSync(file, fs.readFileSync(file, 'utf8').replace('folders: ["_meta", "_Templates"]', 'folders: ["_meta", "_Templates"'));
    const pack = { searchEnabled: true, excludeSections: ['Pack Only Secret'] };
    // The context is built (the CLI reports the file as a finding), it does not throw.
    const ctx = contextOf(vaultPath, root, pack);
    const findings = runChecks(ctx);
    const faults = findings.filter((f) => f.id === 'config/settings-fault');
    assert.equal(faults.length, 1);
    assert.equal(faults[0].severity, 'error');
    assert.equal(faults[0].path, '_meta/vault-config.yaml');
    assert.match(faults[0].message, /^_meta\/vault-config\.yaml is not valid YAML: .* The build will not run until this is fixed\.$/);
    assert.deepEqual(carryOf(findings), []);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('an error that is not the yaml\'s parse failure is not turned into a finding: it propagates', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'scriptorium-carry-'));
  const realResolve = pinned.resolveSiteConfig;
  const realRead = pinned.readPublishSettings;
  try {
    const { vaultPath } = moveVaultCopy(SAMPLE, root);
    const pack = { searchEnabled: true };
    pinned.resolveSiteConfig = () => {
      throw new Error('the disk went away');
    };
    assert.throws(() => contextOf(vaultPath, root, pack), /the disk went away/);
    pinned.resolveSiteConfig = realResolve;
    const ctx = contextOf(vaultPath, root, pack);
    // Throws only for the real read (a yaml present), so the retry without settings cannot hide it.
    pinned.readPublishSettings = (vault, site, files) => {
      if (files.yaml === null) return realRead(vault, site, files);
      throw new Error('the disk went away again');
    };
    assert.throws(() => buildCheckContext({ campaign: 'x', vaultPath, jsonConfig: ctx.jsonConfig, rawSiteConfig: ctx.rawSiteConfig, settingsLayout: 'new' }), /the disk went away again/);
  } finally {
    pinned.resolveSiteConfig = realResolve;
    pinned.readPublishSettings = realRead;
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('callouts: the pin keeps the vault\'s value unless the pack is stricter, in the pin\'s own argument order', () => {
  assert.equal(isHeldByVault('excludeCallouts', ['b'], ['a', 'b']), true);
  assert.equal(isHeldByVault('excludeCallouts', ['Spoiler'], ['spoiler']), true);
  assert.equal(isHeldByVault('excludeCallouts', 'yes', true), true);
  assert.equal(isHeldByVault('excludeCallouts', ['a'], false), false);
  assert.equal(isHeldByVault('excludeCallouts', ['a', 'c'], ['a']), false);
  assert.equal(isHeldByVault('excludeCallouts', true, ['a']), false);
});

test('sections are held as the build matches headings: case does not matter, a different name does', () => {
  assert.equal(isHeldByVault('excludeSections', ['gm notes'], ['GM Notes']), true);
  assert.equal(isHeldByVault('excludeSections', ['GM Notes', 'Secrets'], ['GM Notes']), false);
  assert.equal(isHeldByVault('excludeSections', ['GM Notes'], ['GM Notes']), true);
  // The build reads a hide-list name through its first reading only: this one is "Display", not "Real Name".
  assert.equal(isHeldByVault('excludeSections', ['[[Real Name|Display]]'], ['Real Name']), false);
  assert.equal(isHeldByVault('excludeSections', ['[[Real Name|Display]]'], ['Display']), true);
  assert.equal(isHeldByVault('excludeSections', ['Real Name'], ['[[Real Name|Display]]']), false);
  // A zero-width space inside a name is taken out, so it reads as the plain name.
  assert.equal(isHeldByVault('excludeSections', ['GM\u200bNotes'], ['GMNotes']), true);
});

test('the carry findings are worked out once per context, not once per id', (t) => {
  const fresh = findingsFor({ searchEnabled: true, excludeSections: ['Pack Only Secret'] }).ctx;
  const ctx = { ...fresh }; // a new object, so nothing is cached for it yet
  const spy = t.mock.method(pinned, 'settingFaults');
  carry.runPackHidingNotCarried(ctx);
  carry.runPackSettingNotCarried(ctx);
  carry.runPackSettingDiffers(ctx);
  assert.equal(spy.mock.callCount(), 1);
});

test('isHeldByVault: arrays by entry, callouts by stricterness, objects by key, the rest by equality', () => {
  assert.equal(isHeldByVault('excludeSections', ['a'], ['b', 'a']), true);
  assert.equal(isHeldByVault('excludeSections', ['a', 'c'], ['b', 'a']), false);
  assert.equal(isHeldByVault('excludeDirs', ['./Notes/'], ['Notes']), true);
  assert.equal(isHeldByVault('excludeCallouts', false, true), true);
  assert.equal(isHeldByVault('excludeCallouts', true, false), false);
  assert.equal(isHeldByVault('folderMap', { a: 'x' }, { a: 'x', b: 'y' }), true);
  assert.equal(isHeldByVault('folderMap', { a: 'x' }, { a: 'z' }), false);
  assert.equal(isHeldByVault('siteTitle', 'T', 'T'), true);
  assert.equal(isHeldByVault('siteTitle', 'T', 'U'), false);
});

test('the three divergence checks are silent on a moved vault whose pack differs, and speak on the same context read as legacy', () => {
  const { ctx } = findingsFor(
    { searchEnabled: true, excludeSections: ['Pack Only Secret'], excludeFields: ['pack_only_field'], excludeDirs: ['Pack Folder'] },
    { before: (vault) => {
      // A yaml that names fewer sections and fields than the defaults would, on a legacy vault, drop the rest.
      const file = path.join(vault, '_meta', 'vault-config.yaml');
      const text = fs.readFileSync(file, 'utf8')
        .replace(/ {4}sections: \[.*\]\n/, '    sections: ["GM Notes"]\n')
        .replace(/ {4}fields: \[.*\]\n/, '    fields: ["secrets"]\n');
      fs.writeFileSync(file, text);
    } },
  );
  assert.equal(ctx.settingsLayout, 'new');
  // The dirs check compares the pack with the yaml; on a moved vault the pack holds a folder the yaml lacks.
  const moved = { ...ctx, jsonConfig: { ...ctx.jsonConfig, excludeDirs: ['Pack Folder'] } };
  const legacy = { ...moved, settingsLayout: 'legacy' };
  for (const run of [runExcludeSectionsDivergence, runExcludeDirsDivergence, runExcludeFieldsDivergence]) {
    assert.deepEqual(run(moved), [], `${run.name} is silent on a moved vault`);
    assert.ok(run(legacy).length > 0, `${run.name} speaks on the same context read as legacy`);
  }
});

test('settings-fault leaves out only the site-file hide faults the carry check owns', () => {
  const { ctx } = findingsFor({ searchEnabled: true, excludeSections: ['Pack Only Secret'] });
  assert.ok(ctx.publishSet.stops.some((s) => s.kind === 'old-name' && s.source === 'site'), 'the pin does stop on it');
  assert.deepEqual(runSettingsFault(ctx), []);
  const other = { ...ctx, publishSet: { ...ctx.publishSet, stops: [{ kind: 'not-allowed', name: 'publish.mode', setting: 'player_site.hide.mode', level: 'stop', message: 'x' }] } };
  assert.equal(runSettingsFault(other).length, 1);
});

test('settingEntry gives the registry entry, whose old site name for the tagline is marked not read', () => {
  const entry = pinned.settingEntry('player_site.theme.tagline');
  const was = entry.was.find((w) => w.in === 'site' && w.name === 'landingTagline');
  assert.equal(was.read, false);
});
