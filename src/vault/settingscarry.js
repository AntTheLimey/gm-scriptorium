'use strict';

const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const pinned = require('../generator/pinned');
const backups = require('../config/backups');
const packreplace = require('./packreplace');
const { platformFoldsCase } = require('./exclusions');
const { ScriptoriumError, VaultUnreachableError } = require('../util/errors');
const { stripBom } = require('../util/bom');
const { readSettingsFiles } = require('./publishset');
const { unheldPackSettings } = require('../checks/carry');

/*
 * The carry (rung 3b): folds the settings a campaign pack's vault.config.json still holds into the
 * vault's _meta/vault-config.yaml, with the pin's own move code (src/generator/pinned.js,
 * planSettingsCarry and applySettingsCarry), then rewrites the pack without them. `check` reports the
 * settings that need this (src/checks/carry.js) and names the command that does it.
 *
 * The pin's move wants a site file that names its vault in `vaultPath`, and takes the settings out of
 * that file. The pack has no `vaultPath` and is the GM's, so the pin works on a copy of it in a fresh
 * scratch folder. The plan is made on the copy (nothing in the vault is written), and applying it
 * writes the yaml and the copy; the copy then becomes the new pack through replacePackFile, which
 * refuses if the pack changed since it was read. Every message that would name the copy names the
 * pack instead.
 *
 * The pin's move on an already-moved vault carries only some pack settings: the site-folder keys, the hide
 * lists and callouts (folded in), and the names it no longer reads. It removes the rest of the pack's
 * settings (siteTitle, folderMap, attachmentsDir and so on) from the site file WITHOUT writing them to the
 * yaml. Letting that through would lose them, so:
 *   - siteTitle and folderMap are set in the yaml afterwards with the pin's own settings writer (below);
 *   - any other setting the vault's settings do not hold afterwards stays in the pack, is named in the plan,
 *     and `check` keeps reporting it. It is the GM's to put in _meta/vault-config.yaml.
 *
 * Order of an apply: back up the yaml and the pack (outside the vault, in the per-machine folder), check
 * the pack is as planned, apply the pin's plan (the yaml is written here), rewrite the pack. A failure
 * before the yaml is written changes nothing. A failure of the last step leaves the yaml holding every
 * carried value, so `check` is satisfied; the pack just still holds its old copies.
 */

const YAML_REL = ['_meta', 'vault-config.yaml'];
// The two pack settings the pin's move drops without carrying. This step exists because of the pin defect
// AntTheLimey/gm-apprentice#539, and comes out when a pin carries the fix. The setting names are the
// registry's, read from the pin's own fault for the pack key (fault.setting), not typed here.
const OWN_KEYS = ['siteTitle', 'folderMap'];
const SCRATCH_PREFIX = 'scriptorium-carry-';
const PIN_CHANGED_RE = /changed since the move was planned/;

const sha256 = (buf) => crypto.createHash('sha256').update(buf).digest('hex');
const fold = (s) => (platformFoldsCase() ? s.toLowerCase() : s);

function blocked(blockers) {
  return { state: 'blocked', lines: [], blockers, plan: null, internal: null, unmoved: [] };
}

function removeScratch(dir) {
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch {
    // swallowed deliberately: a leftover scratch folder in the system temp folder must never change
    // what the GM sees or the exit code (src/build/run.js's best-effort removal).
  }
}

/** The real path of a file, or its resolved path when it cannot be resolved. */
function realOrResolved(p) {
  try {
    return fs.realpathSync.native(p);
  } catch {
    return path.resolve(p);
  }
}

function valueAtPath(obj, segs) {
  let at = obj;
  for (const seg of segs) {
    if (!at || typeof at !== 'object' || !Object.prototype.hasOwnProperty.call(at, seg)) return undefined;
    at = at[seg];
  }
  return at;
}

function setAtPath(obj, segs, value) {
  let at = obj;
  for (const seg of segs.slice(0, -1)) {
    if (!at[seg] || typeof at[seg] !== 'object' || Array.isArray(at[seg])) at[seg] = {};
    at = at[seg];
  }
  at[segs[segs.length - 1]] = value;
}

/**
 * The pack settings the vault's settings do not hold, that the carry cannot move: those the vault does not
 * set at all. A hide list is folded in by the pin, and a setting the vault sets differently keeps the
 * vault's value on purpose, so neither counts.
 */
function cannotMove(unheld) {
  return unheld
    .filter((u) => u.fault.level === 'stop' || u.origin !== 'file')
    .map((u) => ({ name: u.fault.name, setting: u.fault.setting, level: u.fault.level }));
}

/** The pin's "settings out of <pack>: a, b, c." line with the names that stay left out of its list. */
function withoutStaying(line, packPath, staying) {
  const head = `${packPath}: `;
  const at = line.indexOf(head);
  if (at < 0 || staying.length === 0) return line;
  const from = at + head.length;
  const m = /^(.*?)\.(?= |$)/.exec(line.slice(from));
  if (!m) return line;
  const keep = m[1].split(', ').filter((n) => !staying.includes(n));
  return `${line.slice(0, from)}${keep.length ? keep.join(', ') : 'nothing'}${line.slice(from + m[1].length)}`;
}

const showValue = (v) => JSON.stringify(v);

/** The title and folder map the yaml sets differently from the pack: the vault's value is kept. */
function differLines(differs) {
  return differs.map(
    (d) => `${d.name} in the pack is ${showValue(d.value)}, but the vault's settings set ${d.setting} to ${showValue(d.vaultValue)}; the vault's value is used.`,
  );
}

function stayLines(unmoved, packPath) {
  return unmoved.map(
    (u) => `${u.name} stays in ${packPath}: the carry cannot move it, and the vault's settings do not set ${u.setting}. Set ${u.setting} in _meta/vault-config.yaml yourself.`,
  );
}

/**
 * Makes the text the pin wrote read as if it had worked on the pack itself: the scratch file (and, as
 * the system may spell it differently, its real path) becomes the pack's path, and the scratch folder
 * the pack's folder.
 */
function namingThePack(text, internal) {
  let out = text;
  const swaps = [
    [internal.scratchFile, internal.packConfigPath],
    [internal.realScratchFile, internal.packConfigPath],
    [internal.scratchDir, path.dirname(internal.packConfigPath)],
    [internal.realScratchDir, path.dirname(internal.packConfigPath)],
  ];
  for (const [from, to] of swaps) if (from) out = out.split(from).join(to);
  return out;
}

/**
 * Plans the carry. Writes only a fresh scratch folder in the system temp folder (kept for
 * applyCarry; discardCarry removes it when the plan is not applied).
 *
 * @param {{ vaultPath: string, campaign: string|null, packConfigPath: string, siteConfig?: object, writePack?: boolean }} args
 *   `siteConfig`: the site settings to carry, used instead of reading `packConfigPath` (init passes the
 *   title it is about to set, with `writePack: false`, and there is no pack file to rewrite).
 *   `writePack` (default true): the pack file is rewritten afterwards, so it must be the pack in the vault.
 * @returns {{ state: 'nothing'|'ready'|'blocked', lines: string[], blockers: string[], plan: object|null, internal: object|null }}
 */
function planCarry({ vaultPath, campaign, packConfigPath, siteConfig, writePack = true }) {
  void campaign;
  if (pinned.settingsLayoutOf(vaultPath) !== 'new') {
    return blocked(['this vault keeps its settings in _meta/vault-config.md; there is nothing to carry']);
  }
  const realVault = fs.realpathSync.native(vaultPath);

  let packBytes = null;
  if (writePack || !siteConfig) {
    try {
      packBytes = fs.readFileSync(packConfigPath);
    } catch (err) {
      return blocked([`could not read ${packConfigPath}: ${err.code || err.message}`]);
    }
  }
  if (writePack) {
    const expected = path.join(realOrResolved(path.join(realVault, '_meta', 'scriptorium')), 'vault.config.json');
    if (fold(realOrResolved(packConfigPath)) !== fold(expected)) {
      return blocked([
        `${packConfigPath} is not the pack in this vault (_meta/scriptorium/vault.config.json), and the carry only rewrites that one. ` +
          'Move the settings by hand, or point the campaign at the pack in the vault.',
      ]);
    }
  }

  let pack = siteConfig;
  if (!pack) {
    try {
      pack = JSON.parse(stripBom(packBytes.toString('utf8')));
    } catch (err) {
      return blocked([`${packConfigPath} is not valid JSON: ${String(err.message).replace(/\s+/g, ' ')}`]);
    }
    if (typeof pack !== 'object' || pack === null || Array.isArray(pack)) {
      return blocked([`${packConfigPath} must contain a JSON object`]);
    }
  }

  const scratchDir = fs.mkdtempSync(path.join(os.tmpdir(), SCRATCH_PREFIX));
  const scratchFile = path.join(scratchDir, 'vault.config.json');
  const internal = {
    vaultPath: realVault,
    packConfigPath,
    scratchDir,
    scratchFile,
    realScratchDir: realOrResolved(scratchDir),
    realScratchFile: path.join(realOrResolved(scratchDir), 'vault.config.json'),
    packSha: packBytes === null ? null : sha256(packBytes),
    hadVaultPath: Object.prototype.hasOwnProperty.call(pack, 'vaultPath'),
    ownVaultPath: pack.vaultPath,
    pack: structuredClone(pack),
    writePack,
  };

  let plan;
  try {
    fs.writeFileSync(scratchFile, JSON.stringify({ ...pack, vaultPath: realVault }, null, 2));
    plan = pinned.planSettingsCarry({ vaultPath: realVault, siteConfigPath: scratchFile });
  } catch (err) {
    removeScratch(scratchDir);
    return blocked([namingThePack(`the vault's settings could not be read: ${String(err.message).replace(/\s+/g, ' ')}`, internal)]);
  }
  if (!plan.ok) {
    removeScratch(scratchDir);
    return blocked(plan.blockers.map((b) => namingThePack(b, internal)));
  }

  const carried = plan.carried || [];
  const dropped = plan.dropped || [];
  const writes = ((plan.files && plan.files.write) || []).map((f) => path.resolve(f));

  // The pack settings the pin removes without carrying them (see the header): they stay in the pack.
  let unmoved;
  let own;
  let differs;
  try {
    const { unheld } = unheldPackSettings(realVault, pack, readSettingsFiles(realVault));
    const carriedFrom = new Set(carried.map((c) => c.from));
    unmoved = cannotMove(unheld).filter((u) => u.level !== 'stop' && !carriedFrom.has(u.name));
    // siteTitle and folderMap are set by the carry itself: the vault does not set them (they move), or it does,
    // differently (its value is used, and the line says so).
    own = unmoved.filter((u) => OWN_KEYS.includes(u.name));
    unmoved = unmoved.filter((u) => !OWN_KEYS.includes(u.name));
    differs = unheld
      .filter((u) => OWN_KEYS.includes(u.fault.name) && u.origin === 'file')
      .map((u) => ({ name: u.fault.name, setting: u.fault.setting, value: u.fault.value, vaultValue: u.vaultValue }));
  } catch (err) {
    removeScratch(scratchDir);
    return blocked([`the vault's settings could not be read: ${String(err.message).replace(/\s+/g, ' ')}`]);
  }
  const stayNames = unmoved.map((u) => u.name);

  const goes = pinned.stripMovedSettings(pack).removed.filter((n) => !stayNames.includes(n));
  const writesYaml = writes.includes(path.resolve(path.join(realVault, ...YAML_REL)));
  if (carried.length === 0 && dropped.length === 0 && !writesYaml && goes.length === 0) {
    removeScratch(scratchDir);
    return { state: 'nothing', lines: stayLines(unmoved, packConfigPath), blockers: [], plan, internal: null, unmoved };
  }
  internal.differs = differs;
  const lines = plan.lines.map((l) => withoutStaying(namingThePack(l, internal), packConfigPath, stayNames));
  const ownLines = own.map((u) => `\`${u.name}\` moves to \`${u.setting}\`.`);
  return { state: 'ready', lines: [...lines, ...ownLines, ...differLines(differs), ...stayLines(unmoved, packConfigPath)], blockers: [], plan, internal, unmoved };
}

/** Removes the scratch folder of a plan that is not going to be applied. Never throws. */
function discardCarry(planned) {
  if (planned && planned.internal) removeScratch(planned.internal.scratchDir);
}

/**
 * Applies a ready plan. Backs up first; see the order in the file header.
 *
 * @param {{ state: string, plan: object, internal: object }} planned from planCarry
 * @param {{ machineDir: string, campaign: string|null, sleep?: (ms: number) => void, now?: () => number, writePack?: boolean }} opts
 *   `writePack` (default true) must match the planCarry call.
 * @returns {{ lines: string[], backups: { yaml: string, pack?: string }, unmoved: { name: string, setting: string }[] }}
 * @throws {VaultUnreachableError} reason 'carry-blocked': a file changed since the plan; nothing was written
 * @throws {ScriptoriumError} a backup failed (nothing written), the yaml could not be written, or the pack
 *   could not be rewritten after the yaml was
 */
function applyCarry(planned, { machineDir, campaign, sleep, now, writePack = true } = {}) {
  const internal = planned && planned.internal;
  if (!internal || planned.state !== 'ready') {
    throw new ScriptoriumError('applyCarry needs a ready plan from planCarry (programming error)', { campaign });
  }
  const { vaultPath, packConfigPath, scratchDir, scratchFile } = internal;
  if (writePack !== internal.writePack) {
    throw new ScriptoriumError('applyCarry: writePack must be the value planCarry was given (programming error)', { campaign });
  }
  try {
    const yamlPath = path.join(vaultPath, ...YAML_REL);
    const stale = (what) =>
      new VaultUnreachableError(
        `${what} changed since the carry was planned; nothing was written. Run "gm-scriptorium carry" again.`,
        { path: packConfigPath, campaign, reason: 'carry-blocked' },
      );

    // 1. Back up. A failure here, or a file that is already different, leaves everything as it was.
    const done = { yaml: null };
    const common = { machineDir, campaign, vaultPath, now };
    if (writePack) {
      let current;
      try {
        current = fs.readFileSync(packConfigPath);
      } catch (err) {
        throw new ScriptoriumError(`could not read ${packConfigPath}: ${err.code || err.message}. Nothing was written.`, { path: packConfigPath, campaign, cause: err });
      }
      if (sha256(current) !== internal.packSha) throw stale(packConfigPath);
      done.pack = backups.writeBackup({ ...common, bytes: current, file: 'vault.config.json' }).path;
    }
    done.yaml = backups.writeBackup({ ...common, bytes: fs.readFileSync(yamlPath), file: 'vault-config.yaml' }).path;

    // 2. The pin's own apply: writes the yaml and the scratch copy of the pack.
    let applied;
    try {
      applied = pinned.applySettingsCarry(planned.plan);
    } catch (err) {
      const message = namingThePack(String(err.message), internal);
      if (PIN_CHANGED_RE.test(message)) throw stale('the vault\'s settings file');
      throw new ScriptoriumError(`the carry could not be applied: ${message.replace(/\s+/g, ' ')}`, { path: yamlPath, campaign, cause: err });
    }
    // What the vault's settings hold now, read back: whatever the pin removed from the pack but did not
    // carry is set here (siteTitle, folderMap) or stays in the pack.
    const unreadable = (err) =>
      new ScriptoriumError(
        `The carry wrote the vault's settings, but they could not be read back (${String(err.message).replace(/\s+/g, ' ')}), so ${packConfigPath} was left as it was. ` +
          `The pack as it was is kept at ${done.pack || 'the backup folder'}.`,
        { path: yamlPath, campaign, cause: err },
      );
    const readBack = () => {
      try {
        return cannotMove(unheldPackSettings(vaultPath, internal.pack, readSettingsFiles(vaultPath)).unheld);
      } catch (err) {
        throw unreadable(err);
      }
    };
    const after = readBack();
    const own = after.filter((u) => OWN_KEYS.includes(u.name));
    let staying = after.filter((u) => !OWN_KEYS.includes(u.name));
    const moved = [];
    let ownFailure = null;
    if (own.length > 0) {
      // Why this step exists: see OWN_KEYS (AntTheLimey/gm-apprentice#539).
      try {
        pinned.applySettingsChanges(vaultPath, own.map((u) => ({ op: 'set', name: u.setting, value: valueAtPath(internal.pack, u.name.split('.')) })));
        const still = readBack().filter((u) => OWN_KEYS.includes(u.name));
        if (still.length > 0) throw new Error('it did not read back as written');
        for (const u of own) moved.push(`\`${u.name}\` moved to \`${u.setting}\`.`);
      } catch (err) {
        if (err instanceof ScriptoriumError) throw err;
        ownFailure = String(err.code || err.message).replace(/\s+/g, ' ');
        staying = [...staying, ...own];
      }
    }
    const ownNames = () => `${own.map((u) => u.name).join(' and ')} ${own.length === 1 ? 'is' : 'are'}`;
    const backupText = `The files as they were are kept at ${done.yaml}${done.pack ? ` and ${done.pack}` : ''}.`;
    const stayNames = staying.map((u) => u.name);
    const lines = (applied.lines || []).map((l) => withoutStaying(namingThePack(l, internal), packConfigPath, stayNames));
    lines.push(...moved, ...stayLines(staying.filter((u) => !OWN_KEYS.includes(u.name)), packConfigPath));

    // 3. The scratch copy becomes the pack, with whatever stays put back.
    if (writePack) {
      try {
        const left = JSON.parse(fs.readFileSync(scratchFile, 'utf8'));
        if (internal.hadVaultPath) left.vaultPath = internal.ownVaultPath;
        else delete left.vaultPath;
        for (const u of staying) {
          const segs = u.name.split('.');
          const value = valueAtPath(internal.pack, segs);
          if (value !== undefined) setAtPath(left, segs, value);
        }
        const text = `${JSON.stringify(left, null, 2)}\n`;
        packreplace.replacePackFile(vaultPath, 'vault.config.json', text, { expectedSha256: internal.packSha, campaign, sleep });
      } catch (err) {
        const why = String(err.code || err.message).replace(/\s+/g, ' ');
        if (ownFailure) {
          // Both failed: the title and folder map are in neither file's new state, so do not say the job is done.
          throw new VaultUnreachableError(
            `The carry could not finish. ${ownNames()} still only in ${packConfigPath}: the vault's settings file could not be written (${ownFailure}), ` +
              `and ${packConfigPath} could not be rewritten (${why}). Nothing is lost. Run "gm-scriptorium carry" again once the files can be written. ${backupText}`,
            { path: yamlPath, campaign, reason: 'carry-blocked' },
          );
        }
        throw new ScriptoriumError(
          `The vault's settings already hold every value that was carried, but ${packConfigPath} could not be rewritten ` +
            `(${why}). It can stay as it is: the vault's settings are the ones used, ` +
            `and nothing else needs doing. The pack as it was is kept at ${done.pack}.`,
          { path: packConfigPath, campaign, cause: err },
        );
      }
      lines.push(`${packConfigPath} was rewritten without the settings that moved.`);
    }
    if (ownFailure) {
      throw new VaultUnreachableError(
        `${ownNames()} still in ${packConfigPath}: the vault's settings file could not be written (${ownFailure}). ` +
          `The rest of the carry is done. Run "gm-scriptorium carry" again once the file can be written. ${backupText}`,
        { path: yamlPath, campaign, reason: 'carry-blocked' },
      );
    }
    return { lines, backups: done, unmoved: staying };
  } finally {
    removeScratch(scratchDir);
  }
}

module.exports = { planCarry, applyCarry, discardCarry };
