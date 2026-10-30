'use strict';

/*
 * `init` against a vault whose settings gm-apprentice moved to _meta/vault-config.yaml (rung 3b).
 * Every case starts from a copy of the sample vault that the pin's own move has already run on,
 * with its campaign pack removed (a new GM's vault). The command runs as the real bin in a scratch
 * root. Expected values are typed by hand from the sample vault, never read from the code under test.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { withScratch, run, SAMPLE } = require('./helpers/b4-cli');
const { moveVaultCopy, assertMovedLayout, replaceChecked } = require('./helpers/moved-vault');

const yamlOf = (vault) => path.join(vault, '_meta', 'vault-config.yaml');
const packJsonOf = (vault) => path.join(vault, '_meta', 'scriptorium', 'vault.config.json');
const backupsIn = (root) => {
  const dir = path.join(root, 'backups', 'campaign-x');
  return fs.existsSync(dir) ? fs.readdirSync(dir).sort() : [];
};
const reports = (out, id) => new RegExp(`^(?:ERROR|WARN|INFO) ${id}`, 'm').test(out);

/** A moved copy of the sample whose yaml sets no title and no folder map, with no pack. */
function movedNoPack(root) {
  const { vaultPath } = moveVaultCopy(SAMPLE, root);
  assertMovedLayout(vaultPath);
  fs.rmSync(path.join(vaultPath, '_meta', 'scriptorium'), { recursive: true, force: true });
  const yaml = fs.readFileSync(yamlOf(vaultPath), 'utf8');
  assert.ok(!/^ {2}title:/m.test(yaml), 'the fixture yaml must set no title');
  assert.ok(!/folder_map:/.test(yaml), 'the fixture yaml must set no folder map');
  return vaultPath;
}

const initArgs = (vault, root, extra = []) => ['init', '--yes', '--name', 'x', '--vault', vault, '--out', path.join(root, 'site'), ...extra];

test('a moved vault with no title: the pack holds none of the moved keys and the yaml gets the title and the folder map', () => {
  withScratch((root) => {
    const vault = movedNoPack(root);
    const res = run(root, initArgs(vault, root));
    assert.equal(res.code, 0, res.all);
    const pack = JSON.parse(fs.readFileSync(packJsonOf(vault), 'utf8'));
    for (const key of ['siteTitle', 'folderMap', 'excludeDirs', 'excludeSections', 'landingTagline', 'attachmentsDir']) {
      assert.ok(!(key in pack), `the pack must not hold ${key}`);
    }
    const yaml = fs.readFileSync(yamlOf(vault), 'utf8');
    assert.match(yaml, /^ {2}title: "?The Long Lease"?$/m);
    assert.match(yaml, /folder_map:/);
    assert.match(yaml, /Characters\/NPCs/);
    assert.match(yaml, /"?_resources"?/, 'the hide list holds the folder init hides');
    const names = backupsIn(root);
    assert.equal(names.length, 1, names.join(','));
    assert.match(names[0], /^vault-config-\d{8}T\d{9}Z-[0-9a-f]{6}\.yaml\.bak$/);
    assert.match(res.out, /carry|vault-config\.yaml/i);
  });
});

test('after init on a moved vault with no title, check does not report the folder map as left in the pack, and a build publishes a mapped entity page', () => {
  withScratch((root) => {
    const vault = movedNoPack(root);
    const out = path.join(root, 'site');
    assert.equal(run(root, initArgs(vault, root)).code, 0);
    fs.writeFileSync(path.join(root, 'config.toml'), `config_version = 1\n[campaigns.x]\nvault = '${vault}'\noutput = '${out}'\n`);
    const check = run(root, ['check', 'x']);
    assert.ok(!reports(check.all, 'config/folder-map-not-carried'), check.all);
    const build = run(root, ['build', 'x']);
    assert.equal(build.code, 0, build.all);
    // The generator always writes a section's index.html; an entity page is there only when the folder is mapped.
    assert.ok(fs.existsSync(path.join(out, 'characters', 'npcs', 'clemency-vare.html')), `characters/npcs holds: ${fs.readdirSync(path.join(out, 'characters', 'npcs'))}`);
  });
});

test('a moved vault that already holds everything init would carry: the yaml is byte-identical and no backup is made', () => {
  withScratch((root) => {
    const vault = movedNoPack(root);
    // The fixture is typed by hand: init's folders, its callouts rule, and a title and a folder map.
    let yaml = fs.readFileSync(yamlOf(vault), 'utf8');
    yaml = replaceChecked(yaml, 'player_site:\n', 'player_site:\n  title: "Typed Title"\n  folder_map:\n    "Characters/NPCs": "characters/npcs"\n');
    yaml = replaceChecked(yaml, 'folders: ["_meta", "_Templates"]', 'folders: ["_meta", "_Templates", "_resources"]');
    yaml = replaceChecked(yaml, '"reliability"]\n', '"reliability"]\n    callouts: true\n');
    fs.writeFileSync(yamlOf(vault), yaml);
    const before = fs.readFileSync(yamlOf(vault));
    const res = run(root, initArgs(vault, root));
    assert.equal(res.code, 0, res.all);
    assert.ok(Buffer.compare(before, fs.readFileSync(yamlOf(vault))) === 0, 'the yaml must not change');
    assert.deepEqual(backupsIn(root), []);
    const pack = JSON.parse(fs.readFileSync(packJsonOf(vault), 'utf8'));
    assert.ok(!('siteTitle' in pack));
  });
});

test('a moved vault whose hide lists already match init but sets no title or folder map: both are added', () => {
  withScratch((root) => {
    const vault = movedNoPack(root);
    let yaml = fs.readFileSync(yamlOf(vault), 'utf8');
    yaml = replaceChecked(yaml, 'folders: ["_meta", "_Templates"]', 'folders: ["_meta", "_Templates", "_resources"]');
    yaml = replaceChecked(yaml, '"reliability"]\n', '"reliability"]\n    callouts: true\n');
    fs.writeFileSync(yamlOf(vault), yaml);
    const res = run(root, initArgs(vault, root));
    assert.equal(res.code, 0, res.all);
    const after = fs.readFileSync(yamlOf(vault), 'utf8');
    assert.match(after, /^ {2}title: "?The Long Lease"?$/m);
    assert.match(after, /Characters\/NPCs/);
    assert.equal(backupsIn(root).length, 1);
  });
});

test('a moved vault whose yaml has only a title: the title is kept and the folder map is added', () => {
  withScratch((root) => {
    const vault = movedNoPack(root);
    const yaml = replaceChecked(fs.readFileSync(yamlOf(vault), 'utf8'), 'player_site:\n', 'player_site:\n  title: "Typed Title"\n');
    fs.writeFileSync(yamlOf(vault), yaml);
    const res = run(root, initArgs(vault, root));
    assert.equal(res.code, 0, res.all);
    const after = fs.readFileSync(yamlOf(vault), 'utf8');
    assert.match(after, /^ {2}title: "?Typed Title"?$/m);
    assert.ok(!/The Long Lease"?$/m.test(after.split('\n').filter((l) => /^ {2}title:/.test(l)).join('\n')));
    assert.match(after, /folder_map:/);
    assert.match(after, /Characters\/NPCs/);
  });
});

test('a moved vault with a title: --title that differs exits 1 and writes nothing', () => {
  withScratch((root) => {
    const vault = movedNoPack(root);
    const yaml = replaceChecked(fs.readFileSync(yamlOf(vault), 'utf8'), 'player_site:\n', 'player_site:\n  title: "Typed Title"\n');
    fs.writeFileSync(yamlOf(vault), yaml);
    const res = run(root, initArgs(vault, root, ['--title', 'Other Title']));
    assert.equal(res.code, 1);
    assert.match(res.err, /this vault's title is set in _meta\/vault-config\.yaml; change it there/);
    assert.equal(fs.readFileSync(yamlOf(vault), 'utf8'), yaml);
    assert.ok(!fs.existsSync(path.join(vault, '_meta', 'scriptorium')));
  });
});

test('--title on a moved vault with no title sets that title in the yaml', () => {
  withScratch((root) => {
    const vault = movedNoPack(root);
    const res = run(root, initArgs(vault, root, ['--title', 'Chosen Name']));
    assert.equal(res.code, 0, res.all);
    assert.match(fs.readFileSync(yamlOf(vault), 'utf8'), /^ {2}title: "?Chosen Name"?$/m);
  });
});

test('re-running init on the same moved vault changes nothing and makes no second backup', () => {
  withScratch((root) => {
    const vault = movedNoPack(root);
    assert.equal(run(root, initArgs(vault, root)).code, 0);
    const yaml = fs.readFileSync(yamlOf(vault));
    const pack = fs.readFileSync(packJsonOf(vault));
    const again = run(root, initArgs(vault, root));
    assert.equal(again.code, 0, again.all);
    assert.ok(Buffer.compare(yaml, fs.readFileSync(yamlOf(vault))) === 0);
    assert.ok(Buffer.compare(pack, fs.readFileSync(packJsonOf(vault))) === 0);
    assert.equal(backupsIn(root).length, 1);
  });
});

test('without --yes, init asks once, in the scaffold question, and a no writes nothing', () => {
  withScratch((root) => {
    const vault = movedNoPack(root);
    const before = fs.readFileSync(yamlOf(vault));
    const args = ['init', '--name', 'x', '--vault', vault, '--out', path.join(root, 'site'), '--title', 'Chosen Name', '--theme', 'gloam'];
    const no = run(root, args, { input: 'n\n' });
    assert.equal(no.code, 1, no.all);
    assert.equal((no.out.match(/\[Y\/n\]/g) || []).length, 1, no.out);
    assert.match(no.out, /vault-config\.yaml/);
    assert.ok(Buffer.compare(before, fs.readFileSync(yamlOf(vault))) === 0);
    assert.ok(!fs.existsSync(packJsonOf(vault)));
    const yes = run(root, args, { input: 'y\n' });
    assert.equal(yes.code, 0, yes.all);
    assert.match(fs.readFileSync(yamlOf(vault), 'utf8'), /^ {2}title: "?Chosen Name"?$/m);
  });
});

test('init --new-vault still makes the old layout', (t) => {
  withScratch((root) => {
    const elsewhere = fs.mkdtempSync(path.join(os.tmpdir(), 'scriptorium-fresh-'));
    t.after(() => fs.rmSync(elsewhere, { recursive: true, force: true }));
    const dest = path.join(elsewhere, 'fresh');
    const res = run(root, ['init', '--yes', '--name', 'x', '--new-vault', dest, '--system', 'none', '--title', 'Fresh Tale', '--out', path.join(root, 'site')]);
    assert.equal(res.code, 0, res.all);
    assert.ok(fs.existsSync(path.join(dest, '_meta', 'vault-config.md')));
    assert.ok(!fs.existsSync(path.join(dest, '_meta', 'vault-config.yaml')));
    assert.ok(fs.existsSync(path.join(dest, '_meta', 'scriptorium', 'vault.config.json')));
  });
});
