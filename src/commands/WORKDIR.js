// @ts-check
import { FileSystem } from '../models/FileSystem.js'
import { GitWalkerFs } from '../models/GitWalkerFs.js'
import { join } from '../utils/join.js'
import { cores } from '../utils/plugins.js'
import { GitWalkerSymbol } from '../utils/symbols.js'

/**
 *
 * @typedef Walker
 * @property {Symbol} Symbol('GitWalkerSymbol')
 */

/**
 * Get a working directory Walker
 *
 * See [walkBeta1](./walkBeta1.md)
 *
 * @param {object} args
 * @param {string} [args.core = 'default'] - The plugin core identifier to use for plugin injection
 * @param {FileSystem} [args.fs] - [deprecated] The filesystem containing the git repo. Overrides the fs provided by the [plugin system](./plugin_fs.md).
 * @param {string} args.dir - The [working tree](dir-vs-gitdir.md) directory path
 * @param {string} [args.gitdir=join(dir, '.git')] - The [git directory](dir-vs-gitdir.md) path
 *
 * @returns {Walker} Returns a working directory Walker
 *
 */
export function WORKDIR ({
  core = 'default',
  dir,
  gitdir = join(dir, '.git'),
  fs: _fs = cores.get(core).get('fs')
}) {
  const fs = new FileSystem(_fs)
  const o = Object.create(null)
  Object.defineProperty(o, GitWalkerSymbol, {
    value: function () {
      return new GitWalkerFs({ fs, dir, gitdir })
    }
  })
  Object.freeze(o)
  return o
}
