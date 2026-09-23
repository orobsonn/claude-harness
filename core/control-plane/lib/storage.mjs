import { createHash, randomBytes } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export const MAX_JSON_BYTES = 1024 * 1024;
const PRIVATE_FILE_MODE = 0o600;
const PRIVATE_DIR_MODE = 0o700;
const CONTROL_HOME_ENTRIES = new Set([
  "projects", "recommendations", "deliveries", "locks", "runtime", "sessions",
  "settings.json", "agent-session.json",
]);
const SAFE_ID = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/;
const SENSITIVE_KEY = /(api.?key|access.?token|refresh.?token|password|passwd|secret|credential|authorization|cookie|transcript|raw.?context)/i;
const SENSITIVE_TEXT = [
  /\bapikey_[A-Za-z0-9_-]{20,}\b/i,
  /\b(?:sk-|gh[pousr]_|glpat-|xox[baprs]-)[A-Za-z0-9_-]{20,}\b/i,
  /\bAKIA[0-9A-Z]{16}\b/,
  /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/,
  /\bBearer\s+[A-Za-z0-9._~+/=-]{16,}/i,
  /\b(?:api.?key|access.?token|refresh.?token|password|passwd|secret|credential)\s*[:=]\s*[^\s,;]{8,}/i,
  /https?:\/\/[^\s/:@]+:[^\s/@]+@/i,
];

export function assertSafeId(value, label = "id") {
  if (typeof value !== "string" || !SAFE_ID.test(value)) {
    throw new Error(`${label} must match ${SAFE_ID}`);
  }
  return value;
}

export function assertPlainObject(value, label = "value") {
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype) {
    throw new Error(`${label} must be a plain object`);
  }
  return value;
}

export function rejectSensitiveFields(value, trail = []) {
  if (typeof value === "string") {
    if (SENSITIVE_TEXT.some((pattern) => pattern.test(value))) {
      throw new Error(`credential-like text rejected: ${trail.join(".") || "value"}`);
    }
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((entry, index) => rejectSensitiveFields(entry, [...trail, String(index)]));
    return;
  }
  if (!value || typeof value !== "object") return;
  for (const [key, entry] of Object.entries(value)) {
    if (SENSITIVE_KEY.test(key)) throw new Error(`sensitive field rejected: ${[...trail, key].join(".")}`);
    rejectSensitiveFields(entry, [...trail, key]);
  }
}

function sortJson(value) {
  if (Array.isArray(value)) return value.map(sortJson);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, sortJson(value[key])]));
}

export function canonicalJson(value) {
  return JSON.stringify(sortJson(value));
}

export function sha256Json(value) {
  return createHash("sha256").update(canonicalJson(value)).digest("hex");
}

export function controlHome(env = process.env, userHome = os.homedir()) {
  const selected = env.HARNESS_CONTROL_HOME ||
    path.join(env.XDG_STATE_HOME || path.join(userHome, ".local", "state"), "claude-harness", "control-plane");
  if (!path.isAbsolute(selected)) throw new Error("HARNESS_CONTROL_HOME must be absolute");
  return path.resolve(selected);
}

function assertOwned(info, target) {
  if (typeof process.getuid === "function" && info.uid !== process.getuid()) {
    throw new Error(`private path is owned by another user: ${target}`);
  }
}

export function assertPrivateDirectory(target) {
  const info = fs.lstatSync(target);
  if (info.isSymbolicLink() || !info.isDirectory()) throw new Error(`private directory invalid: ${target}`);
  assertOwned(info, target);
  if ((info.mode & 0o077) !== 0) throw new Error(`private directory permissions must be 0700: ${target}`);
  if (fs.realpathSync(target) !== path.resolve(target)) throw new Error(`private directory is not canonical: ${target}`);
  return target;
}

export function ensurePrivateDirectory(target) {
  const existed = fs.existsSync(target);
  fs.mkdirSync(target, { recursive: true, mode: PRIVATE_DIR_MODE });
  // Never change permissions on a caller-selected existing directory. A typo
  // such as HARNESS_CONTROL_HOME=/tmp or /home/user must fail without mutating
  // that directory. Newly created leaves get the private mode explicitly.
  if (!existed) fs.chmodSync(target, PRIVATE_DIR_MODE);
  return assertPrivateDirectory(target);
}

export function ensureControlHome(home) {
  if (!path.isAbsolute(home)) throw new Error("control home must be absolute");
  if (path.parse(home).root === path.resolve(home)) throw new Error("control home must be a dedicated non-root directory");
  if (fs.existsSync(home)) {
    const unexpected = fs.readdirSync(home).filter((entry) => !CONTROL_HOME_ENTRIES.has(entry));
    if (unexpected.length) throw new Error(`control home is not dedicated: unexpected entry ${unexpected[0]}`);
  }
  ensurePrivateDirectory(home);
  for (const name of ["projects", "recommendations", "deliveries", "locks", "runtime", "sessions"]) {
    ensurePrivateDirectory(path.join(home, name));
  }
  return fs.realpathSync(home);
}

export function assertWithin(root, target) {
  const rel = path.relative(root, target);
  if (rel === "" || (!rel.startsWith(`..${path.sep}`) && rel !== ".." && !path.isAbsolute(rel))) return target;
  throw new Error(`path escapes control home: ${target}`);
}

export function atomicWriteJson(file, value, { rejectSensitive = true } = {}) {
  assertPlainObject(value);
  if (rejectSensitive) rejectSensitiveFields(value);
  const parent = assertPrivateDirectory(path.dirname(file));
  const body = `${JSON.stringify(value, null, 2)}\n`;
  if (Buffer.byteLength(body) > MAX_JSON_BYTES) throw new Error(`JSON record exceeds ${MAX_JSON_BYTES} bytes`);
  const tmp = path.join(parent, `.${path.basename(file)}.${process.pid}.${randomBytes(8).toString("hex")}.tmp`);
  let fd;
  try {
    fd = fs.openSync(tmp, fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_WRONLY, PRIVATE_FILE_MODE);
    fs.writeFileSync(fd, body, "utf8");
    fs.fsyncSync(fd);
    fs.closeSync(fd);
    fd = undefined;
    fs.renameSync(tmp, file);
    const dirFd = fs.openSync(parent, fs.constants.O_RDONLY);
    try { fs.fsyncSync(dirFd); } finally { fs.closeSync(dirFd); }
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
    try { fs.unlinkSync(tmp); } catch (error) { if (error?.code !== "ENOENT") throw error; }
  }
  return file;
}

export function readPrivateJson(file, { optional = false, rejectSensitive = true } = {}) {
  let info;
  try { info = fs.lstatSync(file); }
  catch (error) {
    if (optional && error?.code === "ENOENT") return null;
    throw error;
  }
  if (info.isSymbolicLink() || !info.isFile() || info.size > MAX_JSON_BYTES) throw new Error(`private JSON invalid: ${file}`);
  assertOwned(info, file);
  if ((info.mode & 0o077) !== 0) throw new Error(`private JSON permissions must be 0600: ${file}`);
  if (fs.realpathSync(file) !== path.resolve(file)) throw new Error(`private JSON is not canonical: ${file}`);
  const value = JSON.parse(fs.readFileSync(file, "utf8"));
  assertPlainObject(value, file);
  if (rejectSensitive) rejectSensitiveFields(value);
  return value;
}

function processStartToken(pid = process.pid) {
  try {
    const stat = fs.readFileSync(`/proc/${pid}/stat`, "utf8");
    const close = stat.lastIndexOf(")");
    const fields = stat.slice(close + 2).split(" ");
    return fields[19] || null;
  } catch {
    return pid === process.pid ? `${process.pid}:${Math.floor(process.uptime())}` : null;
  }
}

function ownerAlive(owner) {
  if (!owner || !Number.isInteger(owner.pid) || owner.pid < 1 || typeof owner.start_token !== "string") return null;
  try { process.kill(owner.pid, 0); } catch (error) {
    if (error?.code === "ESRCH") return false;
    return null;
  }
  const observed = processStartToken(owner.pid);
  if (observed === null) return null;
  return observed === owner.start_token;
}

function recoverDeadLock(lockDir) {
  const ownerPath = path.join(lockDir, "owner.json");
  let owner;
  try { owner = readPrivateJson(ownerPath); } catch { return false; }
  if (ownerAlive(owner) !== false) return false;
  const entries = fs.readdirSync(lockDir);
  if (entries.length !== 1 || entries[0] !== "owner.json") return false;
  fs.unlinkSync(ownerPath);
  fs.rmdirSync(lockDir);
  return true;
}

function acquireLock(home, key) {
  assertSafeId(key, "lock key");
  const locks = assertPrivateDirectory(path.join(home, "locks"));
  const lockDir = path.join(locks, `${key}.lock`);
  for (let attempt = 0; attempt < 2; attempt += 1) {
    let created = false;
    try {
      fs.mkdirSync(lockDir, { mode: PRIVATE_DIR_MODE });
      created = true;
      atomicWriteJson(path.join(lockDir, "owner.json"), {
        schema: "harness.control.lock.v1",
        pid: process.pid,
        start_token: processStartToken(),
        acquired_at: new Date().toISOString(),
      });
      return () => {
        const owner = readPrivateJson(path.join(lockDir, "owner.json"));
        if (owner.pid !== process.pid || owner.start_token !== processStartToken()) {
          throw new Error(`lock ownership changed: ${key}`);
        }
        fs.unlinkSync(path.join(lockDir, "owner.json"));
        fs.rmdirSync(lockDir);
      };
    } catch (error) {
      // A failure between mkdir and publishing owner.json must not leave an
      // ownerless lock that can never be proven stale.
      if (created) {
        try {
          if (fs.readdirSync(lockDir).length === 0) fs.rmdirSync(lockDir);
        } catch { /* Preserve the uncertain lock and fail closed. */ }
      }
      if (error?.code !== "EEXIST" || attempt > 0 || !recoverDeadLock(lockDir)) {
        throw new Error(`control-plane lock busy or uncertain: ${key}`);
      }
    }
  }
  throw new Error(`control-plane lock unavailable: ${key}`);
}

export async function withLock(home, key, fn) {
  const release = acquireLock(home, key);
  try { return await fn(); } finally { release(); }
}

export function readJsonLines(file, { optional = true, maxBytes = 8 * MAX_JSON_BYTES } = {}) {
  let info;
  try { info = fs.lstatSync(file); }
  catch (error) {
    if (optional && error?.code === "ENOENT") return [];
    throw error;
  }
  if (info.isSymbolicLink() || !info.isFile() || info.size > maxBytes) throw new Error(`event log invalid: ${file}`);
  assertOwned(info, file);
  if ((info.mode & 0o077) !== 0) throw new Error(`event log permissions must be 0600: ${file}`);
  const text = fs.readFileSync(file, "utf8");
  const lines = text.split("\n").filter(Boolean);
  return lines.map((line, index) => {
    try { return JSON.parse(line); } catch { throw new Error(`invalid JSONL at ${file}:${index + 1}`); }
  });
}

export function appendJsonLine(file, value) {
  rejectSensitiveFields(value);
  const parent = assertPrivateDirectory(path.dirname(file));
  const body = `${JSON.stringify(value)}\n`;
  if (Buffer.byteLength(body) > 64 * 1024) throw new Error("event exceeds 64 KiB");
  const noFollow = fs.constants.O_NOFOLLOW ?? 0;
  const fd = fs.openSync(file, fs.constants.O_CREAT | fs.constants.O_APPEND | fs.constants.O_WRONLY | noFollow, PRIVATE_FILE_MODE);
  try {
    const info = fs.fstatSync(fd);
    assertOwned(info, file);
    if (!info.isFile() || (info.mode & 0o077) !== 0) throw new Error(`event log invalid: ${file}`);
    fs.writeSync(fd, body, null, "utf8");
    fs.fsyncSync(fd);
  } finally { fs.closeSync(fd); }
  const dirFd = fs.openSync(parent, fs.constants.O_RDONLY);
  try { fs.fsyncSync(dirFd); } finally { fs.closeSync(dirFd); }
}
