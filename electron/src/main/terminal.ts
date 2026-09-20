import { BrowserWindow, dialog } from 'electron';
import { spawn } from 'node:child_process';
import os from 'node:os';

export interface TerminalResult {
  denied?: boolean;
  stdout: string;
  stderr: string;
  exitCode: number | null;
  timedOut: boolean;
}

const MAX_OUTPUT = 32 * 1024; // per stream
const TIMEOUT_MS = 60_000;

function truncate(s: string): string {
  if (s.length <= MAX_OUTPUT) return s;
  return s.slice(0, MAX_OUTPUT) + `\n…[truncated ${s.length - MAX_OUTPUT} chars]`;
}

/**
 * Run a shell command for the agent. THE GATE IS NON-NEGOTIABLE:
 * every invocation shows a native confirmation dialog (command + cwd)
 * and nothing executes unless the user explicitly clicks "Run command".
 */
export async function runTerminal(
  win: BrowserWindow | null,
  command: string,
  cwd?: string
): Promise<TerminalResult> {
  const dir = cwd || os.homedir();

  const { response } = await dialog.showMessageBox(win!, {
    type: 'warning',
    buttons: ['Run command', 'Cancel'],
    defaultId: 1,
    cancelId: 1,
    noLink: true,
    title: 'Agent terminal access',
    message: 'The Next Token agent wants to run a terminal command.',
    detail:
      `Command:\n${command}\n\n` +
      `Working directory:\n${dir}\n\n` +
      `Only run this if you understand what it does. The command runs ` +
      `with your user privileges and can change or delete files.`
  });

  if (response !== 0) {
    return { denied: true, stdout: '', stderr: '', exitCode: null, timedOut: false };
  }

  return new Promise((resolve) => {
    const child = spawn(command, {
      cwd: dir,
      shell: true,
      timeout: TIMEOUT_MS,
      windowsHide: true,
      env: { ...process.env }
    });

    let stdout = '';
    let stderr = '';
    let timedOut = false;

    child.stdout?.on('data', (d: Buffer) => { stdout += d.toString(); });
    child.stderr?.on('data', (d: Buffer) => { stderr += d.toString(); });
    child.on('error', (err) => {
      resolve({ stdout: truncate(stdout), stderr: truncate(stderr) + String(err), exitCode: null, timedOut });
    });
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGKILL');
    }, TIMEOUT_MS + 1000);
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ stdout: truncate(stdout), stderr: truncate(stderr), exitCode: code, timedOut });
    });
  });
}
