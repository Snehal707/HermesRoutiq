import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export interface StripeProjectsStatus {
  ok?: boolean;
  command?: string;
  version?: string;
  data?: Record<string, unknown>;
  meta?: Record<string, unknown>;
  warnings?: unknown[];
  next_steps?: unknown[];
  [key: string]: unknown;
}

function findProjectId(value: unknown): string | null {
  if (!value) {
    return null;
  }

  if (typeof value === "string") {
    return value.startsWith("project_") ? value : null;
  }

  if (Array.isArray(value)) {
    for (const item of value) {
      const found = findProjectId(item);
      if (found) {
        return found;
      }
    }
    return null;
  }

  if (typeof value === "object") {
    for (const nested of Object.values(value as Record<string, unknown>)) {
      const found = findProjectId(nested);
      if (found) {
        return found;
      }
    }
  }

  return null;
}

export async function getStripeProjectsStatus(cwd: string): Promise<{
  projectId: string;
  status: StripeProjectsStatus;
}> {
  const command = process.platform === "win32" ? process.env.ComSpec ?? "cmd.exe" : "stripe";
  const args = process.platform === "win32"
    ? ["/d", "/s", "/c", "stripe projects status --json"]
    : ["projects", "status", "--json"];
  const { stdout, stderr } = await execFileAsync(command, args, {
    cwd,
    windowsHide: true,
    maxBuffer: 1024 * 1024 * 4,
  });

  if (stderr && stderr.trim().length > 0) {
    const lower = stderr.toLowerCase();
    if (lower.includes("error") || lower.includes("failed")) {
      throw new Error(stderr.trim());
    }
  }

  const status = JSON.parse(stdout) as StripeProjectsStatus;
  const projectId = findProjectId(status) ?? findProjectId(status.data) ?? "";
  if (!projectId) {
    throw new Error(`Stripe Projects status did not include a project id. Raw output: ${stdout}`);
  }

  return { projectId, status };
}
