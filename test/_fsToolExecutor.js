// Test helper: workspace-agnostic tool executor backed by plain `fs`.
//
// In production, tools.ts depends on `vscode.workspace.fs` and pops a
// modal confirm before any write. For E2E tests we want to drive the same
// tool-call shapes against a temp directory, deterministically, with
// auto-confirmed writes. This file IS that executor.
//
// Reuses the pure helpers from out/editFile.js and out/repoMap.js so the
// production-and-test split happens only at the I/O boundary.

const fs = require("node:fs");
const path = require("node:path");
const { spawn } = require("node:child_process");

const editFileMod = require("../out/editFile.js");
const repoMapMod = require("../out/repoMap.js");

function resolveInsideRoot(root, rel) {
  if (rel == null || rel === "") throw new Error("Empty path");
  let r = String(rel).trim();
  if (r.includes("..")) throw new Error(`Path must not contain '..': ${rel}`);
  r = r.replace(/\\/g, "/").replace(/^\.\//, "").replace(/^~\//, "").replace(/^\/+/, "");
  if (path.isAbsolute(r)) {
    if (r === root || r.startsWith(root + path.sep)) {
      r = path.relative(root, r);
    } else {
      throw new Error(`Absolute path outside workspace: ${rel}`);
    }
  }
  const abs = path.join(root, r);
  const prefix = root + path.sep;
  if (abs !== root && !abs.startsWith(prefix)) {
    throw new Error(`Path escapes the workspace: ${rel}`);
  }
  return abs;
}

function makeExecutor(root) {
  const writes = []; // recorded for assertions
  const reads = [];

  async function readFile({ path: rel }) {
    const abs = resolveInsideRoot(root, rel);
    reads.push(rel);
    if (!fs.existsSync(abs)) {
      return `File not found: ${rel}. (Safe to create with write_file.)`;
    }
    const text = fs.readFileSync(abs, "utf8");
    const numbered = text.split("\n")
      .map((l, i) => `${String(i + 1).padStart(4, " ")}: ${l}`)
      .join("\n");
    return `File: ${rel} (${Buffer.byteLength(text)} bytes)\n${numbered}`;
  }

  async function writeFile({ path: rel, content }) {
    const abs = resolveInsideRoot(root, rel);
    const existed = fs.existsSync(abs);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, content ?? "", "utf8");
    writes.push({ path: rel, bytes: Buffer.byteLength(content ?? "") });
    return `${existed ? "Updated" : "Created"} ${rel} (${(content ?? "").length} chars).`;
  }

  async function editFile({ path: rel, search, replace }) {
    const abs = resolveInsideRoot(root, rel);
    const exists = fs.existsSync(abs);
    const oldText = exists ? fs.readFileSync(abs, "utf8") : "";
    const result = editFileMod.applySearchReplace(oldText, search ?? "", replace ?? "");
    if (!result.ok) return `ERROR: ${result.message}`;
    if (exists && result.newContent === oldText) {
      return `No changes: ${rel} already matches the requested edit.`;
    }
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, result.newContent, "utf8");
    writes.push({ path: rel, bytes: Buffer.byteLength(result.newContent) });
    return `${exists ? "Edited" : "Created"} ${rel}. ${result.message}`;
  }

  async function listFiles({ path: rel }) {
    const abs = rel && rel !== "." ? resolveInsideRoot(root, rel) : root;
    const entries = fs.readdirSync(abs, { withFileTypes: true })
      .map((d) => `${d.isDirectory() ? "dir " : d.isSymbolicLink() ? "link" : "file"}  ${d.name}`);
    return `Directory: ${rel || "."}\n${entries.join("\n")}`;
  }

  async function searchText({ query, glob }) {
    // Minimal implementation: walk the tree, grep for literal `query`.
    const results = [];
    const re = new RegExp(query.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
    const walk = (dir) => {
      for (const d of fs.readdirSync(dir, { withFileTypes: true })) {
        if (/^(node_modules|\.git|out|dist|build|target)$/.test(d.name)) continue;
        const full = path.join(dir, d.name);
        if (d.isDirectory()) walk(full);
        else if (d.isFile()) {
          const rel = path.relative(root, full);
          const text = fs.readFileSync(full, "utf8");
          text.split("\n").forEach((line, i) => {
            if (re.test(line) && results.length < 50) {
              results.push(`${rel}:${i + 1}: ${line.slice(0, 200)}`);
            }
          });
        }
      }
    };
    walk(root);
    return results.length ? "Matches:\n" + results.join("\n") : "No matches.";
  }

  async function repoMap(_args) {
    // Reuse the production renderer.
    const entries = [];
    const walk = (dir) => {
      for (const d of fs.readdirSync(dir, { withFileTypes: true })) {
        if (/^(node_modules|\.git|out|dist|build|target|vendor|coverage)$/.test(d.name))
          continue;
        const full = path.join(dir, d.name);
        if (d.isDirectory()) { walk(full); continue; }
        if (!d.isFile()) continue;
        const rel = path.relative(root, full);
        const stat = fs.statSync(full);
        if (stat.size > 200 * 1024) continue;
        const symbols = repoMapMod.extractSymbols(rel, fs.readFileSync(full, "utf8"));
        if (symbols.length) entries.push({ path: rel, symbols });
      }
    };
    walk(root);
    if (!entries.length) return "No source files with extractable symbols.";
    return `Repo map (${entries.length} files):\n` + repoMapMod.renderRepoMap(entries);
  }

  async function executeTool(call) {
    try {
      switch (call.name) {
        case "read_file":   return await readFile(call.arguments);
        case "write_file":  return await writeFile(call.arguments);
        case "edit_file":   return await editFile(call.arguments);
        case "list_files":  return await listFiles(call.arguments);
        case "search_text": return await searchText(call.arguments);
        case "repo_map":    return await repoMap(call.arguments);
        default:            return `ERROR: tool not supported in test executor: ${call.name}`;
      }
    } catch (e) {
      return `ERROR: ${e.message}`;
    }
  }

  return { executeTool, writes, reads };
}

/** Spawn a process and capture stdout/stderr/code. Bounded timeout. */
function runProcess(cmd, args, opts = {}) {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, {
      cwd: opts.cwd,
      env: { ...process.env, ...(opts.env || {}) },
    });
    const out = [];
    const err = [];
    let killed = false;
    const t = setTimeout(() => { killed = true; try { child.kill("SIGKILL"); } catch {} },
                         opts.timeoutMs ?? 15000);
    child.stdout.on("data", (b) => out.push(b));
    child.stderr.on("data", (b) => err.push(b));
    child.on("error", (e) => {
      clearTimeout(t);
      resolve({ status: -1, stdout: "", stderr: String(e), killed });
    });
    child.on("close", (status, signal) => {
      clearTimeout(t);
      resolve({
        status: status ?? -1,
        signal: signal ?? null,
        stdout: Buffer.concat(out).toString("utf8"),
        stderr: Buffer.concat(err).toString("utf8"),
        killed,
      });
    });
  });
}

function hasBinary(name) {
  const r = require("node:child_process").spawnSync("which", [name]);
  return r.status === 0;
}

module.exports = { makeExecutor, runProcess, hasBinary };
