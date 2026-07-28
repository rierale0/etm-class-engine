import { spawn } from 'node:child_process';

export interface ProcessResult {
  stdout: string;
  stderr: string;
}

export async function runProcess(
  executable: string,
  args: readonly string[],
  options: { cwd?: string; timeoutMs: number; maxOutputBytes?: number },
): Promise<ProcessResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, [...args], {
      cwd: options.cwd,
      shell: false,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let outputBytes = 0;
    let settled = false;

    const timer = setTimeout(() => {
      child.kill('SIGTERM');
      setTimeout(() => child.kill('SIGKILL'), 5_000).unref();
      finish(new Error(`${executable} timed out`));
    }, options.timeoutMs);
    timer.unref();

    child.stdout.on('data', (chunk: Buffer) => {
      collect(stdout, chunk);
    });
    child.stderr.on('data', (chunk: Buffer) => {
      collect(stderr, chunk);
    });
    child.on('error', finish);
    child.on('close', (code, signal) => {
      if (code === 0) {
        finish(undefined, {
          stdout: Buffer.concat(stdout).toString('utf8'),
          stderr: Buffer.concat(stderr).toString('utf8'),
        });
      } else {
        const detail = Buffer.concat(stderr).toString('utf8').slice(-4_000);
        finish(new Error(`${executable} exited with ${String(code ?? signal)}: ${detail}`));
      }
    });

    function collect(target: Buffer[], chunk: Buffer): void {
      outputBytes += chunk.byteLength;
      if (outputBytes > (options.maxOutputBytes ?? 10_000_000)) {
        child.kill('SIGTERM');
        finish(new Error(`${executable} exceeded its output limit`));
        return;
      }
      target.push(chunk);
    }

    function finish(error?: Error, result?: ProcessResult): void {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) reject(error);
      else if (result) resolve(result);
    }
  });
}
