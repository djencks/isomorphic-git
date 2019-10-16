// @ts-check
import globrex from 'globrex'

import { GitRefManager } from '../managers/GitRefManager.js'
import { FileSystem } from '../models/FileSystem.js'
import { E, GitError } from '../models/GitError.js'
import { join } from '../utils/join.js'
import { patternRoot } from '../utils/patternRoot.js'
import { cores } from '../utils/plugins.js'
import { worthWalking } from '../utils/worthWalking.js'

import { TREE } from './TREE.js'
import { WORKDIR } from './WORKDIR.js'
import { config } from './config.js'
import { walkBeta1 } from './walkBeta1.js'
import { STAGE } from './STAGE.js'
import { flat } from '../utils/flat.js'
import { readObject } from '../storage/readObject.js'
import { GitIndexManager } from '../managers/GitIndexManager.js'
import { normalizeMode } from '../utils/normalizeMode.js'

/**
 * Checkout a branch
 *
 * If the branch already exists it will check out that branch. Otherwise, it will create a new remote tracking branch set to track the remote branch of that name.
 *
 * @param {object} args
 * @param {string} [args.core = 'default'] - The plugin core identifier to use for plugin injection
 * @param {FileSystem} [args.fs] - [deprecated] The filesystem containing the git repo. Overrides the fs provided by the [plugin system](./plugin_fs.md).
 * @param {string} args.dir - The [working tree](dir-vs-gitdir.md) directory path
 * @param {string} [args.gitdir=join(dir,'.git')] - [required] The [git directory](dir-vs-gitdir.md) path
 * @param {import('events').EventEmitter} [args.emitter] - [deprecated] Overrides the emitter set via the ['emitter' plugin](./plugin_emitter.md)
 * @param {string} [args.emitterPrefix = ''] - Scope emitted events by prepending `emitterPrefix` to the event name
 * @param {string} args.ref - Which branch to checkout
 * @param {string[]} [args.filepaths = ['.']] - Limit the checkout to the given files and directories
 * @param {string} [args.pattern = null] - Only checkout the files that match a glob pattern. (Pattern is relative to `filepaths` if `filepaths` is provided.)
 * @param {string} [args.remote = 'origin'] - Which remote repository to use
 * @param {boolean} [args.noCheckout = false] - If true, will update HEAD but won't update the working directory
 * @param {boolean} [args.dryRun = false] - If true, simulates a checkout so you can test whether it would succeed.
 *
 * @returns {Promise<void>} Resolves successfully when filesystem operations are complete
 *
 * @example
 * // checkout the master branch
 * await git.fastCheckout({ dir: '$input((/))', ref: '$input((master))' })
 * console.log('done')
 *
 * @example
 * // checkout only JSON and Markdown files from master branch
 * await git.fastCheckout({ dir: '$input((/))', ref: '$input((master))', pattern: '$input((**\/*.{json,md}))' })
 * console.log('done')
 *
 */
export async function fastCheckout ({
  core = 'default',
  dir,
  gitdir = join(dir, '.git'),
  fs: _fs = cores.get(core).get('fs'),
  emitter = cores.get(core).get('emitter'),
  emitterPrefix = '',
  remote = 'origin',
  ref,
  filepaths = ['.'],
  pattern = null,
  noCheckout = false,
  dryRun = false
}) {
  try {
    const fs = new FileSystem(_fs)
    if (ref === undefined) {
      throw new GitError(E.MissingRequiredParameterError, {
        function: 'checkout',
        parameter: 'ref'
      })
    }
    let patternPart = ''
    let patternGlobrex
    if (pattern) {
      patternPart = patternRoot(pattern)
      if (patternPart) {
        pattern = pattern.replace(patternPart + '/', '')
      }
      patternGlobrex = globrex(pattern, { globstar: true, extended: true })
    }
    const bases = filepaths.map(filepath => join(filepath, patternPart))
    // Get tree oid
    let oid
    try {
      oid = await GitRefManager.resolve({ fs, gitdir, ref })
      // TODO: Figure out what to do if both 'ref' and 'remote' are specified, ref already exists,
      // and is configured to track a different remote.
    } catch (err) {
      // If `ref` doesn't exist, create a new remote tracking branch
      // Figure out the commit to checkout
      const remoteRef = `${remote}/${ref}`
      oid = await GitRefManager.resolve({
        fs,
        gitdir,
        ref: remoteRef
      })
      // Set up remote tracking branch
      await config({
        gitdir,
        fs,
        path: `branch.${ref}.remote`,
        value: `${remote}`
      })
      await config({
        gitdir,
        fs,
        path: `branch.${ref}.merge`,
        value: `refs/heads/${ref}`
      })
      // Create a new branch that points at that same commit
      await fs.write(`${gitdir}/refs/heads/${ref}`, oid + '\n')
    }

    // Return early if HEAD is already at ref oid
    const HEAD = await GitRefManager.resolve({ fs, gitdir, ref: 'HEAD' })

    // Update working dir
    let count = 0
    if (!noCheckout && HEAD !== oid) {
      let ops
      // First pass - just analyze files (not directories) and figure out what needs to be done
      // and (TODO) if it can be done without losing uncommitted changes.
      try {
        ops = await walkBeta1({
          trees: [TREE({ fs, gitdir, ref }), WORKDIR({ fs, dir, gitdir }), STAGE({ fs, gitdir })],
          filter: async function ([commit, workdir, stage]) {
            // match against base paths
            return bases.some(base => worthWalking(commit.fullpath, base))
          },
          map: async function ([commit, workdir, stage]) {
            if (commit.fullpath === '.') return
            // Late filter against file names
            if (patternGlobrex) {
              let match = false
              for (const base of bases) {
                const partToMatch = commit.fullpath.replace(base + '/', '')
                if (patternGlobrex.regex.test(partToMatch)) {
                  match = true
                  break
                }
              }
              if (!match) return
            }
            // Emit progress event
            if (emitter) {
              emitter.emit(`${emitterPrefix}progress`, {
                phase: 'Analyzing workdir',
                loaded: ++count,
                lengthComputable: false
              })
            }
            // This is a kind of silly pattern but it worked so well for me in calculateBasicAuthUsernamePasswordPair.js
            // and it makes intuitively demonstrating exhaustiveness so *easy*.
            // This checks for the presense and/or absense of each of the 3 entries,
            // converts that to a 3-bit binary representation, and then handles
            // every possible combination (2^3 or 8 cases) with a lookup table.
            const key = [!!stage.exists, !!commit.exists, !!workdir.exists]
              .map(Number)
              .join('')
            switch (key) {
              // Impossible case.
              case '000': return
              // Ignore workdir files that are not tracked and not part of the new commit.
              case '001': return
              // New entries
              case '010': {
                await commit.populateStat()
                switch (commit.type) {
                  case 'tree': {
                    return ['mkdir', commit.fullpath]
                  }
                  case 'blob': {
                    await commit.populateHash()
                    return ['create', commit.fullpath, commit.oid, commit.mode]
                  }
                  case 'commit': {
                    // gitlinks
                    console.log(
                      new GitError(E.NotImplementedFail, {
                        thing: 'submodule support'
                      })
                    )
                    return
                  }
                  default: {
                    return ['error', `new entry Unhandled type ${commit.type}`]
                  }
                }
              }
              // New entries but there is already something in the workdir there.
              case '011': {
                await Promise.all([commit.populateStat(), workdir.populateStat()])
                switch (`${commit.type}-${workdir.type}`) {
                  case 'tree-tree': {
                    return // noop
                  }
                  case 'tree-blob':
                  case 'blob-tree': {
                    return ['conflict', commit.fullpath]
                  }
                  case 'blob-blob': {
                    await Promise.all([commit.populateHash(), workdir.populateHash()])
                    // Is the incoming file different?
                    if (commit.oid !== workdir.oid) {
                      return ['conflict', commit.fullpath]
                    } else {
                      // Is the incoming file a different mode?
                      if (commit.mode !== normalizeMode(workdir.mode).toString(8)) {
                        return ['conflict', commit.fullpath]
                      } else {
                        return ['create-index', commit.fullpath, commit.oid, commit.mode]
                      }
                    }
                  }
                  case 'commit-tree': {
                    // TODO: submodule
                    // We'll ignore submodule directories for now.
                    // Users prefer we not throw an error for lack of submodule support.
                    // gitlinks
                    console.log(
                      new GitError(E.NotImplementedFail, {
                        thing: 'submodule support'
                      })
                    )
                  }
                  case 'commit-blob': {
                    // TODO: submodule
                    // But... we'll complain if there is a *file* where we would
                    // put a submodule if we had submodule support.
                    return ['conflict', commit.fullpath]
                  }
                  default: {
                    return ['error', `new entry Unhandled type ${commit.type}`]
                  }
                }
              }
              // Something in stage but not in the commit OR the workdir.
              // Note: I verified this behavior against canonical git.
              case '100': {
                return ['delete-index', stage.fullpath]
              }
              // Deleted entries
              // TODO: How to handle if stage type and workdir type mismatch?
              case '101': {
                await stage.populateStat()
                switch (stage.type) {
                  case 'tree': {
                    return ['rmdir', stage.fullpath]
                  }
                  case 'blob': {
                    // Git checks that the workdir.oid === stage.oid before deleting file
                    await Promise.all([stage.populateHash(), workdir.populateHash()])
                    if (stage.oid !== workdir.oid) {
                      return ['conflict', stage.fullpath]
                    } else {
                      return ['delete', stage.fullpath]
                    }
                  }
                  default: {
                    return [`delete entry Unhandled type ${stage.type}`]
                  }
                }
              }
              // Modified entries but file was deleted in workdir for some reason. Kinda odd case.
              case '110':
              // Modified entries
              case '111': {
                await Promise.all([commit.populateStat(), stage.populateStat()])
                switch (`${stage.type}-${commit.type}`) {
                  case 'tree-tree': {
                    return
                  }
                  case 'blob-blob': {
                    // Check for local changes that would be lost
                    if (workdir.exists) {
                      await workdir.populateStat()
                      await Promise.all([stage.populateHash(), commit.populateHash(), workdir.populateHash()])
                      // Note: canonical git only compares with the stage. But we're smart enough
                      // to compare to the stage AND the incoming commit.
                      if (workdir.oid !== stage.oid && workdir.oid !== commit.oid) {
                        return ['conflict', commit.fullpath]
                      }
                    }
                    // Has file mode changed?
                    if (commit.mode !== normalizeMode(stage.mode).toString(8)) {
                      await commit.populateHash()
                      return ['update', commit.fullpath, commit.oid, commit.mode, true]
                    }
                    // TODO: HANDLE SYMLINKS
                    // Has the file content changed?
                    await Promise.all([commit.populateHash(), stage.populateHash()])
                    if (commit.oid !== stage.oid) {
                      return ['update', commit.fullpath, commit.oid, commit.mode, false]
                    } else {
                      return
                    }
                  }
                  case 'tree-blob': {
                    return ['update-dir-to-blob', commit.fullpath, commit.oid]
                  }
                  case 'blob-tree': {
                    return ['update-blob-to-tree', commit.fullpath]
                  }
                  default: {
                    return ['error', `update entry Unhandled type ${stage.type}-${commit.type}`]
                  }
                }
              }
            }
          },
          // Modify the default flat mapping
          reduce: async function (parent, children) {
            children = flat(children)
            if (!parent) {
              return children
            } else if (parent && parent[0] === 'rmdir') {
              children.push(parent)
              return children
            } else {
              children.unshift(parent)
              return children
            }
          }
        })
      } catch (err) {
        // Throw a more helpful error message for this common mistake.
        if (err.code === E.ReadObjectFail && err.data.oid === oid) {
          throw new GitError(E.CommitNotFetchedError, { ref, oid })
        } else {
          throw err
        }
      }

      // Report conflicts
      const conflicts = ops.filter(([method]) => method === 'conflict').map(([method, fullpath]) => fullpath)
      if (conflicts.length > 0) {
        throw new GitError(E.CheckoutConflictError, { filepaths: conflicts })
      }

      // Collect errors
      const errors = ops.filter(([method]) => method === 'error').map(([method, fullpath]) => fullpath)
      if (errors.length > 0) {
        throw new GitError(E.InternalFail, { message: errors })
      }

      // XXX: for testing, we'll just return here for now.
      if (dryRun) {
        return ops
      }

      // Second pass - execute planned changes
      // The cheapest semi-parallel solution without computing a full dependency graph will be
      // to just do ops in 4 dumb phases: delete files, delete dirs, create dirs, write files

      count = 0
      const total = ops.length
      await GitIndexManager.acquire(
        { fs, filepath: `${gitdir}/index` },
        /**
         *
         * @param {import('../models/GitIndex.js').GitIndex} index
         */
        async function (index) {
          await Promise.all(
            ops.filter(([method]) => method === 'delete' || method === 'delete-index').map(
              async function ([method, fullpath]) {
                const filepath = `${dir}/${fullpath}`
                if (method === 'delete') {
                  await fs.rm(filepath)
                }
                index.delete({ filepath: fullpath })
                if (emitter) {
                  emitter.emit(`${emitterPrefix}progress`, {
                    phase: 'Updating workdir',
                    loaded: ++count,
                    total
                  })
                }
              }
            )
          )
        }
      )

      // Note: this is cannot be done naively in parallel
      for (const [method, fullpath] of ops) {
        if (method === 'rmdir') {
          const filepath = `${dir}/${fullpath}`
          try {
            await fs.rmdir(filepath)
            if (emitter) {
              emitter.emit(`${emitterPrefix}progress`, {
                phase: 'Updating workdir',
                loaded: ++count,
                total
              })
            }
          } catch (e) {
            if (e.code === 'ENOTEMPTY') {
              console.log(`Did not delete ${fullpath} because directory is not empty`)
            } else {
              throw e
            }
          }
        }
      }

      await Promise.all(
        ops.filter(([method]) => method === 'mkdir').map(
          async function ([_, fullpath]) {
            const filepath = `${dir}/${fullpath}`
            await fs.mkdir(filepath)
            if (emitter) {
              emitter.emit(`${emitterPrefix}progress`, {
                phase: 'Updating workdir',
                loaded: ++count,
                total
              })
            }
          }
        )
      )

      await GitIndexManager.acquire(
        { fs, filepath: `${gitdir}/index` },
        /**
         *
         * @param {import('../models/GitIndex.js').GitIndex} index
         */
        async function (index) {
          await Promise.all(
            ops.filter(([method]) => method === 'create' || method === 'create-index' || method === 'update').map(
              async function ([method, fullpath, oid, mode, chmod]) {
                const filepath = `${dir}/${fullpath}`
                try {
                  if (method !== 'create-index') {
                    const { object } = await readObject({ fs, gitdir, oid })
                    if (chmod) {
                      // Note: the mode option of fs.write only works when creating files,
                      // not updating them. Since the `fs` plugin doesn't expose `chmod` this
                      // is our only option.
                      await fs.rm(filepath)
                    }
                    if (mode === '100644') {
                      // regular file
                      await fs.write(filepath, object)
                    } else if (mode === '100755') {
                      // executable file
                      await fs.write(filepath, object, { mode: 0o777 })
                    } else if (mode === '120000') {
                      // symlink
                      await fs.writelink(filepath, object)
                    } else {
                      throw new GitError(E.InternalFail, {
                        message: `Invalid mode "${mode}" detected in blob ${oid}`
                      })
                    }
                  }

                  const stats = await fs.lstat(filepath)
                  // We can't trust the executable bit returned by lstat on Windows,
                  // so we need to preserve this value from the TREE.
                  // TODO: Figure out how git handles this internally.
                  if (mode === '100755') {
                    stats.mode = 0o755
                  }
                  index.insert({
                    filepath: fullpath,
                    stats,
                    oid
                  })
                  if (emitter) {
                    emitter.emit(`${emitterPrefix}progress`, {
                      phase: 'Updating workdir',
                      loaded: ++count,
                      total
                    })
                  }
                } catch (e) {
                  console.log(e)
                }
              }
            )
          )
        }
      )
    }

    // Update HEAD
    const fullRef = await GitRefManager.expand({ fs, gitdir, ref })
    const content = fullRef.startsWith('refs/heads') ? `ref: ${fullRef}` : oid
    await fs.write(`${gitdir}/HEAD`, `${content}\n`)
  } catch (err) {
    err.caller = 'git.checkout'
    throw err
  }
}
