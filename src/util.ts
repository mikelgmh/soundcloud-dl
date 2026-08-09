import { spawn } from 'node:child_process';
import readline from 'node:readline';

export interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
}

export function run(
  cmd: string[],
  opts: { capture?: boolean } = {},
): Promise<RunResult> {
  return new Promise((resolve) => {
    const child = spawn(cmd[0], cmd.slice(1), {
      stdio: opts.capture ? ['inherit', 'pipe', 'pipe'] : 'inherit',
    });
    let stdout = '';
    let stderr = '';
    if (opts.capture) {
      child.stdout?.on('data', (d: Buffer) => (stdout += d));
      child.stderr?.on('data', (d: Buffer) => (stderr += d));
    }
    child.on('close', (code) =>
      resolve({ code: code ?? -1, stdout, stderr }),
    );
    child.on('error', (err) =>
      resolve({ code: -1, stdout, stderr: String(err) }),
    );
  });
}

export interface RunStreamOpts {
  onStdout?: (line: string) => void;
  onStderr?: (line: string) => void;
  signal?: AbortSignal;
  controller?: ProcessController;
}

export interface ProcessController {
  pause: () => void;
  resume: () => void;
}

/** Lanza un comando capturando su salida línea a línea (para la GUI). */
export function runStream(cmd: string[], opts: RunStreamOpts = {}): Promise<number> {
  return new Promise((resolve) => {
    const child = spawn(cmd[0], cmd.slice(1), {
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    if (opts.controller) {
      const pid = child.pid;
      opts.controller.pause = () => {
        if (pid == null) return;
        try {
          process.kill(pid, 'SIGSTOP');
        } catch {
          // no disponible (p.ej. Windows)
        }
      };
      opts.controller.resume = () => {
        if (pid == null) return;
        try {
          process.kill(pid, 'SIGCONT');
        } catch {
          // no disponible
        }
      };
    }
    const rlOut = readline.createInterface({ input: child.stdout! });
    const rlErr = readline.createInterface({ input: child.stderr! });
    rlOut.on('line', (l) => opts.onStdout?.(l));
    rlErr.on('line', (l) => opts.onStderr?.(l));
    const abort = () => {
      try {
        child.kill('SIGKILL');
      } catch {
        // ya terminó
      }
    };
    opts.signal?.addEventListener('abort', abort, { once: true });
    child.on('close', (code) => {
      opts.signal?.removeEventListener('abort', abort);
      resolve(code ?? -1);
    });
    child.on('error', () => {
      opts.signal?.removeEventListener('abort', abort);
      resolve(-1);
    });
  });
}

export const sleep = (ms: number) =>
  new Promise((resolve) => setTimeout(resolve, ms));
