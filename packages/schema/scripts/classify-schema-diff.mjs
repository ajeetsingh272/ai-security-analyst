/**
 * Pure classification logic, split out of check-compatibility.mjs (P3-08
 * T1/T2) so it has a real, in-process unit test — importing
 * check-compatibility.mjs itself would run its own top-level CLI body
 * (reading schema.snapshot.json, possibly calling process.exit) as an
 * import side effect, which is exactly what a pure-function unit test
 * must not trigger. This file has no side effects at all: no file reads,
 * no process.exit, just the diff.
 */

/** Every breaking difference between two schema shapes, as human-readable
 * strings. Empty means the diff is additive-or-identical — safe. */
export function findBreakingChanges(before, after) {
  const breaks = [];

  for (const [name, values] of Object.entries(before.unions)) {
    const nowValues = after.unions[name];
    if (!nowValues) {
      breaks.push(`union "${name}" was removed`);
      continue;
    }
    for (const v of values) {
      if (!nowValues.includes(v)) breaks.push(`union "${name}" lost the value "${v}"`);
    }
  }

  for (const [name, iface] of Object.entries(before.interfaces)) {
    const nowIface = after.interfaces[name];
    if (!nowIface) {
      breaks.push(`interface "${name}" was removed`);
      continue;
    }
    const nowFields = new Map(nowIface.fields.map((f) => [f.name, f]));
    for (const field of iface.fields) {
      const nowField = nowFields.get(field.name);
      if (!nowField) {
        breaks.push(`"${name}.${field.name}" was removed`);
        continue;
      }
      if (JSON.stringify(nowField.type) !== JSON.stringify(field.type)) {
        breaks.push(
          `"${name}.${field.name}" changed type (${JSON.stringify(field.type)} -> ${JSON.stringify(nowField.type)})`,
        );
      }
      // A required field becoming optional is additive (existing callers
      // that always set it still work); only the reverse is breaking.
      if (field.optional && !nowField.optional) {
        breaks.push(`"${name}.${field.name}" changed from optional to required`);
      }
    }
  }

  return breaks;
}

/** True if `after`'s version has a strictly greater MAJOR component than
 * `before`'s — the one thing a breaking change is required to come with. */
export function isMajorBump(beforeVersion, afterVersion) {
  const before = parseVersion(beforeVersion);
  const after = parseVersion(afterVersion);
  return after.major > before.major;
}

function parseVersion(v) {
  const m = /^(\d+)\.(\d+)\.(\d+)$/.exec(v);
  if (!m) throw new Error(`classify-schema-diff: "${v}" is not a semver MAJOR.MINOR.PATCH string.`);
  return { major: Number(m[1]), minor: Number(m[2]), patch: Number(m[3]) };
}
