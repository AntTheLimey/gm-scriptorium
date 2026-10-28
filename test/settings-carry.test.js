'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { PassThrough } = require('stream');

const { withScratch, run, SAMPLE } = require('./helpers/b4-cli');
const { moveVaultCopy } = require('./helpers/moved-vault');
const { runCarryCommand } = require('../src/cli/carry');
const { planCarry, applyCarry } = require('../src/vault/settingscarry');
const packreplace = require('../src/vault/packreplace');
const { VaultUnreachableError, ScriptoriumError } = require('../src/util/errors');

/*
 * `gm-scriptorium carry` (rung 3b): folds the pack's leftover site settings into a moved vault's
 * _meta/vault-config.yaml with the pin's own move code, then rewrites the pack without them.
 * Every case starts from a copy of the sample vault that the pin's own move has already run on,
 * with 'Pack Only Secret' added to the pack's hide list, which the yaml does not hold.
 */

const CARRY_IDS = ['config/pack-hiding-not-carried', 'config/pack-setting-not-carried', 'config/pack-setting-differs'];
// What the planner's scratch folder is called; it must never reach the GM's screen.
const SCRATCH_PREFIX = 'scriptorium-carry-';

// A finding line, not the list of checks that ran (the human report ends with that list).
const reports = (out, id) => new RegExp(`^(?:ERROR|WARN|INFO) ${id}`, 'm').test(out);
const sha = (buf) => crypto.createHash('sha256').update(buf).digest('hex');
const yamlOf = (vault) => path.join(vault, '_meta', 'vault-config.yaml');
const packOf = (vault) => path.join(vault, '_meta', 'scriptorium', 'vault.config.json');

function register(root, vault) {
  fs.writeFileSync(path.join(root, 'config.toml'), `config_version = 1\n[campaigns.t]\nvault = '${vault}'\noutput = '${path.join(root, 'site')}'\n`);
}

/**
 * A moved copy of the sample whose move already folded the pack in (so the yaml holds the title, the
 * folder map and the hide lists), with the pack then given one hide entry the yaml lacks. Registered as
 * campaign "t".
 */
function setup(root) {
  const { vaultPath } = moveVaultCopy(SAMPLE, root, { inVaultPack: true });
  const pack = JSON.parse(fs.readFileSync(packOf(vaultPath), 'utf8'));
  assert.ok(!('excludeSections' in pack), 'the move must have taken the hide list out of the pack');
  pack.excludeSections = ['Pack Only Secret'];
  fs.writeFileSync(packOf(vaultPath), JSON.stringify(pack, null, 2));
  register(root, vaultPath);
  return vaultPath;
}

/**
 * A moved copy of the sample whose move did NOT fold the pack in: the yaml sets no title and no folder
 * map, and the pack still holds the lot (plus 'Pack Only Secret'). What a vault gets when gm-apprentice
 * moves it without knowing where Scriptorium keeps the pack.
 */
function setupUnfolded(root) {
  const { vaultPath } = moveVaultCopy(SAMPLE, root);
  const pack = JSON.parse(fs.readFileSync(packOf(vaultPath), 'utf8'));
  pack.excludeSections.push('Pack Only Secret');
  fs.writeFileSync(packOf(vaultPath), JSON.stringify(pack, null, 2));
  register(root, vaultPath);
  return vaultPath;
}

function backupsIn(root) {
  const dir = path.join(root, 'backups', 'campaign-t');
  return fs.existsSync(dir) ? fs.readdirSync(dir).sort() : [];
}

function insideVault(vault) {
  const found = [];
  (function walk(d) {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const full = path.join(d, e.name);
      if (e.isDirectory()) walk(full);
      else if (e.name.endsWith('.bak')) found.push(full);
    }
  })(vault);
  return found;
}

/** Runs the command in this process. `onQuestion` runs when the question is printed, before the answer is read. */
async function inProcess(root, { yes = false, answer = 'y\n', onQuestion } = {}) {
  const input = new PassThrough();
  let out = '';
  const output = {
    isTTY: false,
    write(s) {
      out += s;
      if (onQuestion && s.includes('[y/N]')) {
        const f = onQuestion;
        onQuestion = null;
        f();
        input.end(answer);
      }
      return true;
    },
  };
  if (!yes && !onQuestion) input.end(answer);
  const flags = { config: path.join(root, 'config.toml') };
  if (yes) flags.yes = true;
  try {
    const result = await runCarryCommand(flags, [], { input, output, now: () => Date.parse('2026-10-27T10:00:00Z'), env: {} });
    return { code: result.exitCode, out };
  } catch (err) {
    if (err instanceof VaultUnreachableError) return { code: 3, out, err };
    if (err instanceof ScriptoriumError) return { code: 1, out, err };
    throw err;
  }
}

test('carry --yes folds the pack into the yaml, strips the pack, backs both up outside the vault and names real paths', () => {
  withScratch((root) => {
    const vault = setup(root);
    const yamlBefore = fs.readFileSync(yamlOf(vault), 'utf8');
    assert.ok(!yamlBefore.includes('Pack Only Secret'));
    const res = run(root, ['carry', '--yes']);
    assert.equal(res.code, 0, res.all);
    assert.ok(fs.readFileSync(yamlOf(vault), 'utf8').includes('Pack Only Secret'));
    const pack = JSON.parse(fs.readFileSync(packOf(vault), 'utf8'));
    assert.ok(!('excludeSections' in pack));
    assert.ok(!('vaultPath' in pack));
    assert.equal(backupsIn(root).length, 2, backupsIn(root).join(','));
    assert.ok(backupsIn(root).some((n) => /^vault-config-\d{8}T\d{9}Z-[0-9a-f]{6}\.yaml\.bak$/.test(n)));
    assert.ok(backupsIn(root).some((n) => /^vault\.config-\d{8}T\d{9}Z-[0-9a-f]{6}\.json\.bak$/.test(n)));
    assert.deepEqual(insideVault(vault), []);
    assert.ok(res.out.includes(packOf(vault)), res.out);
    assert.ok(!res.all.includes(SCRATCH_PREFIX), res.all);
  });
});

test('the backups hold the files as they were before the carry', () => {
  withScratch((root) => {
    const vault = setup(root);
    const yamlBytes = fs.readFileSync(yamlOf(vault));
    const packBytes = fs.readFileSync(packOf(vault));
    assert.equal(run(root, ['carry', '--yes']).code, 0);
    const dir = path.join(root, 'backups', 'campaign-t');
    const yamlBak = backupsIn(root).find((n) => n.endsWith('.yaml.bak'));
    const packBak = backupsIn(root).find((n) => n.endsWith('.json.bak'));
    assert.equal(sha(fs.readFileSync(path.join(dir, yamlBak))), sha(yamlBytes));
    assert.equal(sha(fs.readFileSync(path.join(dir, packBak))), sha(packBytes));
  });
});

test('settings the pin cannot carry stay in the pack, named, and the hide list still moves', () => {
  withScratch((root) => {
    const vault = setupUnfolded(root);
    assert.ok(!/^\s+title:/m.test(fs.readFileSync(yamlOf(vault), 'utf8')), 'the yaml must not set a title yet');
    const res = run(root, ['carry', '--yes']);
    assert.equal(res.code, 0, res.all);
    assert.ok(fs.readFileSync(yamlOf(vault), 'utf8').includes('Pack Only Secret'));
    const pack = JSON.parse(fs.readFileSync(packOf(vault), 'utf8'));
    // The pin removes these from the pack without writing them to the yaml; the carry puts them back.
    assert.equal(pack.siteTitle, 'The Long Lease');
    assert.equal(pack.folderMap.Sessions, 'sessions');
    assert.ok(!('excludeSections' in pack));
    assert.ok(!('excludeDirs' in pack));
    assert.ok(!('landingTagline' in pack));
    for (const name of ['siteTitle', 'folderMap']) {
      assert.ok(res.out.includes(`${name} stays in ${packOf(vault)}`), `${name} not named:\n${res.out}`);
    }
    // The hide list was the error; what is left are warnings, which still name the carry.
    const checked = run(root, ['check']);
    assert.equal(checked.code, 0, checked.all);
    assert.ok(!reports(checked.out, 'config/pack-hiding-not-carried'));
    // A second carry has nothing more to move, says so, and still names what stays.
    const again = run(root, ['carry', '--yes']);
    assert.equal(again.code, 0, again.all);
    assert.match(again.out, /nothing to carry/);
    assert.ok(again.out.includes(`siteTitle stays in ${packOf(vault)}`), again.out);
  });
});

test('a second carry says there is nothing to carry, exits 0 and makes no backup', () => {
  withScratch((root) => {
    const vault = setup(root);
    assert.equal(run(root, ['carry', '--yes']).code, 0);
    const yamlAfter = fs.readFileSync(yamlOf(vault));
    const packAfter = fs.readFileSync(packOf(vault));
    const backups = backupsIn(root);
    const again = run(root, ['carry', '--yes']);
    assert.equal(again.code, 0, again.all);
    assert.match(again.out, /nothing to carry/);
    assert.deepEqual(backupsIn(root), backups);
    assert.equal(Buffer.compare(fs.readFileSync(yamlOf(vault)), yamlAfter), 0);
    assert.equal(Buffer.compare(fs.readFileSync(packOf(vault)), packAfter), 0);
  });
});

test('after the carry, check exits 0 with none of the three carry ids, and build succeeds', () => {
  withScratch((root) => {
    setup(root);
    const before = run(root, ['check']);
    assert.equal(before.code, 2, before.all);
    assert.match(before.out, /config\/pack-hiding-not-carried/);
    assert.equal(run(root, ['carry', '--yes']).code, 0);
    const checked = run(root, ['check']);
    assert.equal(checked.code, 0, checked.all);
    for (const id of CARRY_IDS) assert.ok(!reports(checked.out, id), `${id} still reported:\n${checked.out}`);
    const built = run(root, ['build']);
    assert.equal(built.code, 0, built.all);
    assert.ok(fs.existsSync(path.join(root, 'site', 'index.html')));
  });
});

test('when the pack cannot be rewritten (EACCES), carry exits 1, says the vault settings hold everything, and check is clean', async () => {
  const root = fs.mkdtempSync(path.join(require('os').tmpdir(), 'scriptorium-b4-'));
  const real = packreplace.replacePackFile;
  try {
    const vault = setup(root);
    packreplace.replacePackFile = () => {
      const e = new Error('EACCES: permission denied');
      e.code = 'EACCES';
      throw e;
    };
    const res = await inProcess(root, { yes: true });
    packreplace.replacePackFile = real;
    assert.equal(res.code, 1, res.out);
    assert.match(res.err.message, /vault's settings already hold every value that was carried/);
    assert.ok(res.err.message.includes(packOf(vault)), res.err.message);
    assert.match(res.err.message, /vault\.config-\d{8}T\d{9}Z-[0-9a-f]{6}\.json\.bak/);
    assert.match(res.err.message, /nothing else needs doing/);
    assert.ok(fs.readFileSync(yamlOf(vault), 'utf8').includes('Pack Only Secret'));
    const checked = run(root, ['check']);
    assert.equal(checked.code, 0, checked.all);
    for (const id of CARRY_IDS) assert.ok(!reports(checked.out, id), `${id} still reported:\n${checked.out}`);
  } finally {
    packreplace.replacePackFile = real;
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('a yaml edited between the plan and the apply exits 3 and leaves both files exactly as the edit left them', async () => {
  const root = fs.mkdtempSync(path.join(require('os').tmpdir(), 'scriptorium-b4-'));
  try {
    const vault = setup(root);
    let yamlAfterEdit;
    let packAfterEdit;
    const res = await inProcess(root, {
      onQuestion() {
        fs.appendFileSync(yamlOf(vault), '\n# edited by hand after the plan\n');
        yamlAfterEdit = fs.readFileSync(yamlOf(vault));
        packAfterEdit = fs.readFileSync(packOf(vault));
      },
    });
    assert.equal(res.code, 3, res.out);
    assert.equal(res.err.reason, 'carry-blocked');
    assert.match(res.err.message, /changed since/);
    assert.equal(Buffer.compare(fs.readFileSync(yamlOf(vault)), yamlAfterEdit), 0);
    assert.equal(Buffer.compare(fs.readFileSync(packOf(vault)), packAfterEdit), 0);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('the pack edited between the plan and the apply is not overwritten', async () => {
  const root = fs.mkdtempSync(path.join(require('os').tmpdir(), 'scriptorium-b4-'));
  try {
    const vault = setup(root);
    let packAfterEdit;
    const res = await inProcess(root, {
      onQuestion() {
        const pack = JSON.parse(fs.readFileSync(packOf(vault), 'utf8'));
        pack.siteTitle = 'Changed After The Plan';
        fs.writeFileSync(packOf(vault), JSON.stringify(pack, null, 2));
        packAfterEdit = fs.readFileSync(packOf(vault));
      },
    });
    // Caught before anything is written: the yaml is untouched too.
    assert.equal(res.code, 3, res.out);
    assert.equal(res.err.reason, 'carry-blocked');
    assert.equal(Buffer.compare(fs.readFileSync(packOf(vault)), packAfterEdit), 0);
    assert.ok(!fs.readFileSync(yamlOf(vault), 'utf8').includes('Pack Only Secret'));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('run through a symlink to the vault, carry still carries', { skip: process.platform === 'win32' }, () => {
  withScratch((root) => {
    const vault = setup(root);
    const link = path.join(root, 'link-to-vault');
    fs.symlinkSync(vault, link, 'dir');
    register(root, link);
    const res = run(root, ['carry', '--yes']);
    assert.equal(res.code, 0, res.all);
    assert.ok(fs.readFileSync(yamlOf(vault), 'utf8').includes('Pack Only Secret'));
    assert.ok(!('excludeSections' in JSON.parse(fs.readFileSync(packOf(vault), 'utf8'))));
    assert.deepEqual(insideVault(vault), []);
    assert.ok(!res.all.includes(SCRATCH_PREFIX), res.all);
  });
});

test('a yaml the pin cannot parse: exit 3, nothing written, no backup', () => {
  withScratch((root) => {
    const vault = setup(root);
    fs.writeFileSync(yamlOf(vault), 'player_site: [unclosed\n  - : :\n');
    const yamlBefore = fs.readFileSync(yamlOf(vault));
    const packBefore = fs.readFileSync(packOf(vault));
    const res = run(root, ['carry', '--yes']);
    assert.equal(res.code, 3, res.all);
    assert.equal(Buffer.compare(fs.readFileSync(yamlOf(vault)), yamlBefore), 0);
    assert.equal(Buffer.compare(fs.readFileSync(packOf(vault)), packBefore), 0);
    assert.deepEqual(backupsIn(root), []);
    assert.ok(!res.all.includes(SCRATCH_PREFIX), res.all);
  });
});

test('closed stdin without --yes: exit 1, nothing written', () => {
  withScratch((root) => {
    const vault = setup(root);
    const yamlBefore = fs.readFileSync(yamlOf(vault));
    const packBefore = fs.readFileSync(packOf(vault));
    const res = run(root, ['carry'], { input: '' });
    assert.equal(res.code, 1, res.all);
    assert.match(res.all, /carry aborted; nothing written/);
    assert.equal(Buffer.compare(fs.readFileSync(yamlOf(vault)), yamlBefore), 0);
    assert.equal(Buffer.compare(fs.readFileSync(packOf(vault)), packBefore), 0);
    assert.deepEqual(backupsIn(root), []);
  });
});

test('answering n writes nothing and exits 0; answering y carries', () => {
  withScratch((root) => {
    const vault = setup(root);
    const no = run(root, ['carry'], { input: 'n\n' });
    assert.equal(no.code, 0, no.all);
    assert.match(no.out, /Carry these settings into the vault's settings file\? \[y\/N\]/);
    assert.ok(!fs.readFileSync(yamlOf(vault), 'utf8').includes('Pack Only Secret'));
    assert.deepEqual(backupsIn(root), []);
    const yes = run(root, ['carry'], { input: 'y\n' });
    assert.equal(yes.code, 0, yes.all);
    assert.ok(fs.readFileSync(yamlOf(vault), 'utf8').includes('Pack Only Secret'));
  });
});

test('a legacy vault: exit 3 and "nothing to carry"', () => {
  withScratch((root) => {
    const vault = path.join(root, 'legacy');
    fs.cpSync(SAMPLE, vault, { recursive: true });
    register(root, vault);
    const res = run(root, ['carry', '--yes']);
    assert.equal(res.code, 3, res.all);
    assert.match(res.all, /nothing to carry/);
    assert.deepEqual(backupsIn(root), []);
  });
});

test('a pack that lives outside the vault is refused before anything is written', () => {
  withScratch((root) => {
    const vault = setup(root);
    const outside = path.join(root, 'outside', 'vault.config.json');
    fs.mkdirSync(path.dirname(outside), { recursive: true });
    fs.copyFileSync(packOf(vault), outside);
    fs.writeFileSync(path.join(root, 'config.toml'), `config_version = 1\n[campaigns.t]\nvault = '${vault}'\nsite_config = '${outside}'\noutput = '${path.join(root, 'site')}'\n`);
    const yamlBefore = fs.readFileSync(yamlOf(vault));
    const res = run(root, ['carry', '--yes']);
    assert.equal(res.code, 3, res.all);
    assert.match(res.all, /_meta\/scriptorium|_meta[\\/]scriptorium/);
    assert.equal(Buffer.compare(fs.readFileSync(yamlOf(vault)), yamlBefore), 0);
    assert.deepEqual(backupsIn(root), []);
  });
});

// --- the module, driven directly (the options Task 8's init uses) ---------------------------------

function planFor(root, vault, extra = {}) {
  return planCarry({ vaultPath: vault, campaign: 't', packConfigPath: packOf(vault), ...extra });
}

test('planCarry writes only its scratch folder and reports the pack as the site file', () => {
  withScratch((root) => {
    const vault = setup(root);
    const yamlBefore = fs.readFileSync(yamlOf(vault));
    const packBefore = fs.readFileSync(packOf(vault));
    const planned = planFor(root, vault);
    assert.equal(planned.state, 'ready');
    assert.deepEqual(planned.blockers, []);
    assert.equal(Buffer.compare(fs.readFileSync(yamlOf(vault)), yamlBefore), 0);
    assert.equal(Buffer.compare(fs.readFileSync(packOf(vault)), packBefore), 0);
    const text = planned.lines.join('\n');
    assert.ok(text.includes(packOf(vault)), text);
    assert.ok(!text.includes(SCRATCH_PREFIX), text);
  });
});

test('planCarry with a siteConfig object uses it instead of the pack file, and messages still name the pack path', () => {
  withScratch((root) => {
    const vault = setup(root);
    const planned = planFor(root, vault, { siteConfig: { excludeSections: ['Only This Section'] }, writePack: false });
    assert.equal(planned.state, 'ready');
    const text = planned.lines.join('\n');
    assert.ok(text.includes(packOf(vault)), text);
    // The pack file's own hide entry is not in the plan: the object stood in for the file.
    assert.ok(!text.includes('Pack Only Secret'), text);
  });
});

test('applyCarry with writePack false changes only the yaml, and makes one backup', () => {
  withScratch((root) => {
    const vault = setup(root);
    const packBefore = fs.readFileSync(packOf(vault));
    const planned = planFor(root, vault, { siteConfig: { excludeSections: ['Only This Section'] }, writePack: false });
    const done = applyCarry(planned, { machineDir: root, campaign: 't', writePack: false });
    assert.ok(fs.readFileSync(yamlOf(vault), 'utf8').includes('Only This Section'));
    assert.equal(Buffer.compare(fs.readFileSync(packOf(vault)), packBefore), 0);
    assert.equal(backupsIn(root).length, 1);
    assert.deepEqual(Object.keys(done.backups).sort(), ['yaml']);
  });
});

test('applyCarry with the default writePack rewrites the pack and reports both backups', () => {
  withScratch((root) => {
    const vault = setup(root);
    const planned = planFor(root, vault);
    const done = applyCarry(planned, { machineDir: root, campaign: 't' });
    assert.deepEqual(Object.keys(done.backups).sort(), ['pack', 'yaml']);
    assert.ok(done.lines.length > 0);
    assert.equal(backupsIn(root).length, 2);
  });
});

test('a backup failure leaves everything unchanged', () => {
  withScratch((root) => {
    const vault = setup(root);
    const yamlBefore = fs.readFileSync(yamlOf(vault));
    const packBefore = fs.readFileSync(packOf(vault));
    const planned = planFor(root, vault);
    // The machine folder is a file, so no backup folder can be made inside it.
    const notAFolder = path.join(root, 'a-file');
    fs.writeFileSync(notAFolder, 'x');
    assert.throws(() => applyCarry(planned, { machineDir: notAFolder, campaign: 't' }), /could not back up/);
    assert.equal(Buffer.compare(fs.readFileSync(yamlOf(vault)), yamlBefore), 0);
    assert.equal(Buffer.compare(fs.readFileSync(packOf(vault)), packBefore), 0);
  });
});
