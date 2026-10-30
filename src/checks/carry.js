'use strict';

const { isDeepStrictEqual } = require('util');
const { createFinding } = require('../report/finding');
const { readSettingsFiles } = require('../vault/publishset');
const pinned = require('../generator/pinned');

/*
 * What `check` says about the pack's leftover settings on a vault whose settings moved to
 * _meta/vault-config.yaml (rung 3b). From the move on, the generator reads those settings from the
 * yaml only; a value still in the pack's vault.config.json is not read. A GM runs
 * "gm-scriptorium carry" to fold the pack's values into the yaml. Until then:
 *
 *   - a hide-list entry the pack holds and the vault's list lacks would be lost, so it is an ERROR
 *     (config/pack-hiding-not-carried): the page or section it hid would publish;
 *   - a folder map the pack holds and the vault does not set is an ERROR (config/folder-map-not-carried):
 *     the build would map no folder and publish a near-empty site over the players' one;
 *   - any other setting the pack holds and the vault does not set is a WARN
 *     (config/pack-setting-not-carried);
 *   - a setting the pack and the vault both set, to different values, is a WARN
 *     (config/pack-setting-differs); the vault's value is the one used.
 *
 * It also reports a _meta/vault-config.md that the move left beside the yaml
 * (config/leftover-settings-file, WARN), from the pin's own "dropped" fault.
 *
 * The findings come from the pin's own fault list (kind 'old-name', source 'site'), so the keys
 * and settings are the pin's, not a list kept here. A setting the pin reports but no longer reads
 * (landingTagline, `read: false` in its registry entry) is never reported: there is nothing to
 * carry. Nothing here writes to the vault.
 */

const carryHint = (campaign) => `Run "gm-scriptorium carry ${campaign}" to move it into the vault's settings.`;

/** The value at a dotted name in a nested object, or undefined. */
function valueAt(obj, dotted) {
  let at = obj;
  for (const seg of dotted.split('.')) {
    if (!at || typeof at !== 'object') return undefined;
    at = at[seg];
  }
  return at;
}

/**
 * How the scanner would spell a hide-list folder, lower-cased as it matches them; an entry the pin
 * cannot spell is kept as written.
 */
function folderKey(entry, vaultPath) {
  const spelled = typeof entry === 'string' ? pinned.normalizeExcludeDir(entry, vaultPath, false) : null;
  return String(spelled || entry).toLowerCase();
}

/** The pack entries of a list that the vault's list lacks. Folders are compared as the scanner spells them. */
function missingEntries(packKey, packList, vaultList, vaultPath) {
  // A section name is read by the build through its single headingKey, so two names with equal keys hide
  // the same headings. A title's other readings (titleNamedIn) must not be used here: they would call
  // "[[Real Name|Display]]" held by "Real Name" while the pack strips "Display" and the vault does not.
  if (packKey === 'excludeSections') {
    const held = new Set(vaultList.map((v) => pinned.headingKey(String(v))));
    return packList.filter((e) => !held.has(pinned.headingKey(String(e))));
  }
  const key = packKey === 'excludeDirs' ? (e) => folderKey(e, vaultPath) : (e) => e;
  const held = new Set(vaultList.map(key));
  return packList.filter((e) => !held.has(key(e)));
}

/**
 * Does the vault's setting already hold what the pack holds, so that carrying would change nothing?
 * An array is held when every pack entry is in the vault's array (folders as the scanner spells
 * them). excludeCallouts is held when the stricter of the two values is the vault's own. An object
 * is held when every pack key is in the vault's object with an equal value. Anything else is held
 * when the two are equal.
 *
 * @param {string} packKey the pack's key (`excludeDirs`, `siteTitle`, a dotted `backend.statusBar`)
 * @param {*} packValue
 * @param {*} vaultValue the vault's value for the setting, its default when the file does not set it
 * @param {string} [vaultPath] resolves a folder entry written as an absolute path
 * @returns {boolean}
 */
function isHeldByVault(packKey, packValue, vaultValue, vaultPath) {
  if (packKey === 'excludeCallouts') return isDeepStrictEqual(pinned.stricterCallouts(vaultValue, packValue), vaultValue);
  if (Array.isArray(packValue)) {
    return Array.isArray(vaultValue) && missingEntries(packKey, packValue, vaultValue, vaultPath).length === 0;
  }
  if (packValue && typeof packValue === 'object') {
    if (!vaultValue || typeof vaultValue !== 'object' || Array.isArray(vaultValue)) return false;
    return Object.keys(packValue).every((k) => Object.prototype.hasOwnProperty.call(vaultValue, k) && isDeepStrictEqual(packValue[k], vaultValue[k]));
  }
  return isDeepStrictEqual(packValue, vaultValue);
}

/** True when the pin no longer reads this site-file name (`read: false` on the registry entry's old name). */
function pinIgnores(fault) {
  const entry = pinned.settingEntry(fault.setting);
  const was = entry && (entry.was || []).find((w) => w.in === 'site' && w.name === fault.name);
  return Boolean(was && was.read === false);
}

function show(value) {
  return JSON.stringify(value);
}

/**
 * The three carry checks share one read of the pin's faults and the vault's settings, so they are
 * produced together and split by id. Quiet on a legacy vault, where the pack is still read.
 */
const cache = new WeakMap();
function carryFindings(ctx) {
  if (!cache.has(ctx)) cache.set(ctx, computeCarryFindings(ctx));
  return cache.get(ctx);
}

/**
 * The pin's faults for a pack, and the ones the vault's settings do not already hold: the pack's
 * `old-name` faults (kind 'old-name', source 'site') for settings the pin still reads, minus those
 * whose value the vault holds (isHeldByVault). Each entry carries the pin's fault and the vault's
 * value for the setting. The carry (src/vault/settingscarry.js) asks the same question, before and
 * after it runs, so what `check` reports and what the carry moves cannot drift apart.
 *
 * @param {string} vaultPath
 * @param {object} packConfig the pack as read (vault.config.json content)
 * @param {{ md: string|null, yaml: string|null }} files the vault's settings files
 * @returns {{ faults: object[], unheld: { fault: object, vaultValue: *, origin: string }[] }}
 * @throws a settings file the pin cannot parse
 */
function unheldPackSettings(vaultPath, packConfig, files) {
  const faults = pinned.settingFaults(vaultPath, packConfig, files);
  const settings = pinned.readSettingValues(vaultPath, packConfig, files);
  const unheld = [];
  for (const fault of faults) {
    if (fault.kind !== 'old-name' || fault.source !== 'site' || !fault.setting) continue;
    if (pinIgnores(fault)) continue;
    const vaultValue = valueAt(settings.values, fault.setting);
    if (isHeldByVault(fault.name, fault.value, vaultValue, vaultPath)) continue;
    unheld.push({ fault, vaultValue, origin: settings.origins[fault.setting] });
  }
  return { faults, unheld };
}

function computeCarryFindings(ctx) {
  if (ctx.settingsLayout !== 'new' || !ctx.rawSiteConfig) return [];
  const files = readSettingsFiles(ctx.vaultPath);
  let faults;
  let unheld;
  try {
    ({ faults, unheld } = unheldPackSettings(ctx.vaultPath, ctx.rawSiteConfig, files));
  } catch {
    // A settings file the pin cannot parse is reported where it is read (the build stops on the
    // pin's own error); there are no resolved values here to compare the pack with.
    return [];
  }
  const findings = [];
  for (const fault of faults) {
    // The pin's own "dropped" fault for the old settings page (setting null; a dropped folder entry has one).
    if (fault.kind === 'dropped' && fault.setting === null && fault.name === '_meta/vault-config.md') {
      findings.push(createFinding({
        id: 'config/leftover-settings-file',
        severity: 'warn',
        category: 'config',
        campaign: ctx.campaign,
        path: '_meta/vault-config.md',
        message: "_meta/vault-config.md is left over from before gm-apprentice's update and is not read. This vault's settings are in _meta/vault-config.yaml.",
        data: {},
      }));
    }
  }
  for (const { fault, vaultValue, origin } of unheld) {
    const base = { category: 'config', campaign: ctx.campaign, path: null };
    const data = { packKey: fault.name, setting: fault.setting };
    if (fault.level === 'stop') {
      const entries = Array.isArray(fault.value) && Array.isArray(vaultValue)
        ? missingEntries(fault.name, fault.value, vaultValue, ctx.vaultPath).map(String)
        : (Array.isArray(fault.value) ? fault.value.map(String) : []);
      const what = entries.length
        ? `${entries.map((e) => `"${e}"`).join(', ')} would be published`
        : 'what it hides would be published';
      findings.push(createFinding({
        ...base,
        id: 'config/pack-hiding-not-carried',
        severity: 'error',
        message: `${fault.name} in the pack hides more than the vault's settings do (${fault.setting}), and the build no longer reads the pack, so ${what}. ${carryHint(ctx.campaign)}`,
        data: { ...data, entries },
      }));
    } else if (origin === 'file') {
      findings.push(createFinding({
        ...base,
        id: 'config/pack-setting-differs',
        severity: 'warn',
        message: `${fault.name} in the pack is ${show(fault.value)}, but the vault's settings set ${fault.setting} to ${show(vaultValue)}; the vault's value is used. ${carryHint(ctx.campaign)}`,
        data,
      }));
    } else if (fault.name === 'folderMap') {
      // The build reads no folder map from the pack, and with none in the vault's settings it maps no
      // folder at all: it would publish a near-empty site over the players' one, with exit 0.
      findings.push(createFinding({
        ...base,
        id: 'config/folder-map-not-carried',
        severity: 'error',
        message: `The folder map is still only in the pack (${ctx.packConfigPath || 'its vault.config.json'}), so the build would publish none of the mapped folders. Run "gm-scriptorium carry ${ctx.campaign}" to move it into _meta/vault-config.yaml.`,
        data,
      }));
    } else {
      findings.push(createFinding({
        ...base,
        id: 'config/pack-setting-not-carried',
        severity: 'warn',
        message: `${fault.name} in the pack is ${show(fault.value)}, but the vault's settings do not set ${fault.setting}, so the pack's value is not used. ${carryHint(ctx.campaign)}`,
        data,
      }));
    }
  }
  return findings;
}

const only = (id) => (ctx) => carryFindings(ctx).filter((f) => f.id === id);

module.exports = {
  isHeldByVault,
  unheldPackSettings,
  carryHint,
  runPackHidingNotCarried: only('config/pack-hiding-not-carried'),
  runPackSettingNotCarried: only('config/pack-setting-not-carried'),
  runFolderMapNotCarried: only('config/folder-map-not-carried'),
  runPackSettingDiffers: only('config/pack-setting-differs'),
  runLeftoverSettingsFile: only('config/leftover-settings-file'),
  missingEntries,
};
