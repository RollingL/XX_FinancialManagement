// Clean-up for tests that open ledgers in temporary folders.
//
// node:test runs t.after hooks in the order they were added, but clean-up has to run the
// other way round: a ledger opened in a folder must be closed before the folder is removed.
// Windows refuses to delete a file that is still open (Linux allows it, which once hid this),
// so on Linux removeFolder also refuses while this process still has a file in it open.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const stacks = new WeakMap();

// Runs fn when the test ends: the last one added runs first. Every step runs even if an
// earlier one fails; the first failure is reported.
function cleanup(t, fn) {
  let stack = stacks.get(t);
  if (!stack) {
    stack = [];
    stacks.set(t, stack);
    t.after(async () => {
      let failure;
      while (stack.length) {
        try {
          await stack.pop()();
        } catch (error) {
          failure ??= error;
        }
      }
      if (failure) throw failure;
    });
  }
  stack.push(fn);
}

function openFilesInside(dir) {
  if (process.platform !== 'linux' || !fs.existsSync(dir)) return [];
  const inside = fs.realpathSync(dir) + path.sep;
  return fs
    .readdirSync('/proc/self/fd')
    .map((fd) => {
      try {
        return fs.readlinkSync(path.join('/proc/self/fd', fd));
      } catch {
        return '';
      }
    })
    .filter((file) => file.startsWith(inside));
}

function removeFolder(dir) {
  const open = openFilesInside(dir);
  if (open.length)
    throw Error(`Still open, so Windows could not remove the folder: ${open.join(', ')}`);
  fs.rmSync(dir, { recursive: true, force: true });
}

// A new empty folder in the system temporary folder, removed when the test ends (after
// everything opened in it later has been closed).
function temporaryFolder(t, prefix) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  cleanup(t, () => removeFolder(dir));
  return dir;
}

module.exports = { cleanup, removeFolder, temporaryFolder };
