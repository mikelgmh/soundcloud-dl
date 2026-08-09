import { spawn, type ChildProcess } from 'node:child_process';
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

/** Señala al proceso y, en POSIX, a todo su grupo (yt-dlp + subprocesos como
 *  ffmpeg). En Windows solo se puede terminar el proceso (sin pausa real). */
function signalProcess(
  child: ChildProcess,
  signal: NodeJS.Signals,
): boolean {
  if (process.platform !== 'win32' && child.pid) {
    try {
      process.kill(-child.pid, signal);
      return true;
    } catch {
      // grupo no disponible; se intenta el proceso directo
    }
  }
  try {
    return child.kill(signal);
  } catch {
    return false;
  }
}

/** Lanza un comando capturando su salida línea a línea (para la GUI). */
export function runStream(cmd: string[], opts: RunStreamOpts = {}): Promise<number> {
  return new Promise((resolve) => {
    const child = spawn(cmd[0], cmd.slice(1), {
      stdio: ['ignore', 'pipe', 'pipe'],
      // Grupo de procesos propio para poder pausar/detener también los
      // subprocesos (ffmpeg) con una sola señal.
      detached: true,
    });
    if (opts.controller) {
      opts.controller.pause = () => {
        signalProcess(child, 'SIGSTOP');
      };
      opts.controller.resume = () => {
        signalProcess(child, 'SIGCONT');
      };
    }
    const rlOut = readline.createInterface({ input: child.stdout! });
    const rlErr = readline.createInterface({ input: child.stderr! });
    rlOut.on('line', (l) => opts.onStdout?.(l));
    rlErr.on('line', (l) => opts.onStderr?.(l));
    const abort = () => {
      signalProcess(child, 'SIGKILL');
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
