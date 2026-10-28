/**
 * What a member is told to do about an env key a workflow step requires and
 * this machine has no value for (#1513).
 *
 * `teamai env set KEY` only works for a key the team declares, as a secret or
 * as an env variable, so advice that names it for a key the team does not
 * declare sends the member to a command that exits 1. The advice here names
 * the command only for the keys it works for, and the environment for the
 * rest, which always works.
 */
import { sameEnvName } from './resources/env-key.js';

/**
 * How to give each of `keys` a value here. Each key needs a value, so groups
 * of declared and undeclared keys are joined with "and"; the alternatives
 * live inside one group. `teamai env set KEY` is for a key the team declares,
 * and the environment for a key it does not. An added key still needs its
 * value with `teamai env set KEY`.
 *
 * `declared` is the keys the team declares here, as `EnvFacts` holds them.
 */
export function envValueAdvice(keys: readonly string[], declared: ReadonlySet<string>): string {
  const known: string[] = [];
  const unknown: string[] = [];
  for (const key of keys) (sameEnvName(declared, key) === undefined ? unknown : known).push(key);
  const one = keys.length === 1;
  const sets = known.map((key) => `teamai env set ${key}`).join(', ');
  const adds = unknown.map((key) => `teamai env add ${key} --secret`).join(', ');
  const valueSets = unknown.map((key) => `teamai env set ${key}`).join(', ');
  const values = unknown.length === 1
    ? `give it a value with ${valueSets}`
    : `give them values with ${valueSets}`;
  const declare = `declare ${one ? 'it' : unknown.join(', ')} in the team repo (${adds}; ${values})`;
  if (unknown.length === 0) {
    return `Run ${sets}, or set ${one ? 'it' : 'them'} in the environment`;
  }
  if (known.length === 0) {
    return `Set ${one ? 'it' : 'them'} in the environment, or ${declare}`;
  }
  return `Run ${sets}, or set ${known.join(', ')} in the environment, and set ${unknown.join(', ')} in the environment, or ${declare}`;
}
