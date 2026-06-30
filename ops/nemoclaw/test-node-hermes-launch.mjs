import { exec, execFile } from "node:child_process";
import { promisify } from "node:util";

const runExec = promisify(exec);
const runExecFile = promisify(execFile);

const json = JSON.stringify({
  model: "hermes-agent",
  messages: [{ role: "user", content: "Reply with the word ok" }],
  temperature: 0,
  stream: false,
});
const payload = Buffer.from(json, "utf8").toString("base64");
const scriptPath = "/mnt/c/Users/ASUS/HermesRoutiq/ops/nemoclaw/hermes-chat-completions.sh";
const cmd = `wsl.exe -d Ubuntu-24.04 -e bash ${scriptPath} hermes-runway ${payload}`;

async function main() {
  const mode = process.argv[2] ?? "execFile-wsl";

  try {
    let result;
    if (mode === "exec") {
      result = await runExec(cmd, {
        timeout: 30_000,
        maxBuffer: 1024 * 1024 * 8,
      });
    } else if (mode === "execFile-cmd") {
      result = await runExecFile("cmd.exe", ["/d", "/s", "/c", cmd], {
        timeout: 30_000,
        maxBuffer: 1024 * 1024 * 8,
      });
    } else {
      result = await runExecFile("wsl.exe", [
        "-d",
        "Ubuntu-24.04",
        "-e",
        "bash",
        scriptPath,
        "hermes-runway",
        payload,
      ], {
        timeout: 30_000,
        maxBuffer: 1024 * 1024 * 8,
      });
    }

    console.log(JSON.stringify({ mode, stdout: result.stdout, stderr: result.stderr }));
  } catch (error) {
    const err = error;
    console.error(JSON.stringify({
      mode,
      message: err instanceof Error ? err.message : String(err),
      code: typeof err === "object" && err && "code" in err ? err.code : null,
      signal: typeof err === "object" && err && "signal" in err ? err.signal : null,
      killed: typeof err === "object" && err && "killed" in err ? err.killed : null,
      stdout: typeof err === "object" && err && "stdout" in err ? err.stdout : null,
      stderr: typeof err === "object" && err && "stderr" in err ? err.stderr : null,
    }, null, 2));
    process.exitCode = 1;
  }
}

void main();
