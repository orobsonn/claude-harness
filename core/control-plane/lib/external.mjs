import { execFile } from "node:child_process";

const MAX_OUTPUT = 8 * 1024 * 1024;

function executeFile(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = execFile(command, args, {
      cwd: options.cwd,
      env: options.env,
      encoding: "utf8",
      timeout: options.timeout ?? 120_000,
      maxBuffer: MAX_OUTPUT,
      signal: options.signal,
    }, (error, stdout, stderr) => {
      if (error) {
        error.stdout = stdout;
        error.stderr = stderr;
        reject(error);
      } else resolve({ stdout, stderr });
    });
    if (options.input !== undefined) {
      child.stdin.end(options.input);
    }
  });
}

export function createExternalRunner(injected = {}) {
  const run = injected.run ?? executeFile;
  const bin = {
    orca: injected.orcaBin ?? process.env.ORCA_BIN ?? process.env.ORCA_CLI_COMMAND ?? "orca",
    gh: injected.ghBin ?? process.env.GH_BIN ?? "gh",
    git: injected.gitBin ?? process.env.GIT_BIN ?? "git",
    crontab: injected.crontabBin ?? process.env.CRONTAB_BIN ?? "crontab",
  };
  return {
    async text(command, args, options = {}) {
      const result = await run(command, args, options);
      return typeof result === "string" ? result : result.stdout;
    },
    async json(command, args, options = {}) {
      const text = await this.text(command, args, options);
      try { return JSON.parse(text); }
      catch { throw new Error(`${command} returned malformed JSON`); }
    },
    async orca(args, options = {}) {
      let response;
      try { response = await this.json(bin.orca, [...args, "--json"], options); }
      catch (error) {
        if (typeof error?.stdout === "string" && error.stdout.trim()) {
          try { response = JSON.parse(error.stdout); } catch { throw error; }
        } else throw error;
      }
      if (response?.ok !== true || !response.result) {
        const code = response?.error?.code ?? "unknown";
        const message = response?.error?.message ?? "Orca refused or returned an invalid response";
        const error = new Error(`Orca ${code}: ${message}`);
        error.code = code;
        throw error;
      }
      return response.result;
    },
    async gh(args, options = {}) {
      return this.json(bin.gh, args, options);
    },
    async git(args, options = {}) {
      return (await this.text(bin.git, args, options)).trim();
    },
    async crontabRead() {
      try { return await this.text(bin.crontab, ["-l"]); }
      catch (error) {
        if (/no crontab/i.test(String(error?.stderr ?? ""))) return "";
        throw error;
      }
    },
    async crontabWrite(text) {
      await this.text(bin.crontab, ["-"], { input: text });
    },
  };
}

export function shellQuote(value) {
  if (typeof value !== "string" || value.includes("\0")) throw new Error("shell argument must be a NUL-free string");
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

export function terminalCommand(command, args) {
  return `exec ${[command, ...args].map(shellQuote).join(" ")}`;
}
