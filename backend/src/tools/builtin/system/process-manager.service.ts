import { Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { spawn, type ChildProcess } from 'node:child_process';
import * as path from 'node:path';
import { randomUUID } from 'node:crypto';

// ─── Types ────────────────────────────────────────────────────────────────────

export interface ManagedProcess {
  id: string;
  command: string;
  cwd: string;
  pid: number;
  startedAt: string;
  status: 'running' | 'exited';
  exitCode: number | null;
  /** Ring buffer for stdout */
  stdout: string[];
  /** Ring buffer for stderr */
  stderr: string[];
  /** Cursor: how many stdout lines have been polled */
  stdoutCursor: number;
  /** Cursor: how many stderr lines have been polled */
  stderrCursor: number;
  child: ChildProcess;
}

export interface ProcessInfo {
  id: string;
  command: string;
  cwd: string;
  pid: number;
  startedAt: string;
  status: 'running' | 'exited';
  exitCode: number | null;
}

/** Max lines kept per stream (ring buffer) */
const MAX_BUFFER_LINES = 500;
/** Max concurrent background processes */
const MAX_PROCESSES = 10;
/** Max output returned per poll */
const MAX_POLL_OUTPUT = 8_000;

@Injectable()
export class ProcessManagerService implements OnModuleDestroy {
  private readonly logger = new Logger(ProcessManagerService.name);
  private readonly processes = new Map<string, ManagedProcess>();
  private readonly workingDirectory: string;

  constructor(private readonly configService: ConfigService) {
    this.workingDirectory = this.configService.get<string>(
      'tools.systemRun.workingDirectory',
      process.cwd(),
    );
  }

  /** Kill all managed processes on shutdown */
  onModuleDestroy(): void {
    for (const proc of this.processes.values()) {
      if (proc.status === 'running') {
        try {
          proc.child.kill('SIGTERM');
        } catch {
          // already dead
        }
      }
    }
    this.processes.clear();
  }

  /**
   * Start a new background process.
   */
  start(command: string, cwd?: string): ProcessInfo {
    if (this.runningCount() >= MAX_PROCESSES) {
      throw new Error(`Too many background processes (max ${MAX_PROCESSES}). Kill some first.`);
    }

    const resolvedCwd = this.resolveCwd(cwd);
    const id = randomUUID().slice(0, 8);

    const shell = process.platform === 'win32'
      ? (process.env.ComSpec ?? 'cmd.exe')
      : (process.env.SHELL ?? '/bin/bash');

    const child = spawn(shell, ['-c', command], {
      cwd: resolvedCwd,
      stdio: ['pipe', 'pipe', 'pipe'],
      detached: false,
      env: {
        ...process.env,
        PAGER: 'cat',
      },
    });

    if (!child.pid) {
      throw new Error('Failed to spawn process — no PID assigned');
    }

    const managed: ManagedProcess = {
      id,
      command,
      cwd: resolvedCwd,
      pid: child.pid,
      startedAt: new Date().toISOString(),
      status: 'running',
      exitCode: null,
      stdout: [],
      stderr: [],
      stdoutCursor: 0,
      stderrCursor: 0,
      child,
    };

    // Wire stdout
    child.stdout?.on('data', (chunk: Buffer) => {
      const lines = chunk.toString().split('\n');
      for (const line of lines) {
        if (line || managed.stdout.length > 0) {
          managed.stdout.push(line);
          if (managed.stdout.length > MAX_BUFFER_LINES) {
            managed.stdout.shift();
            // adjust cursor so it doesn't point past buffer
            if (managed.stdoutCursor > 0) managed.stdoutCursor--;
          }
        }
      }
    });

    // Wire stderr
    child.stderr?.on('data', (chunk: Buffer) => {
      const lines = chunk.toString().split('\n');
      for (const line of lines) {
        if (line || managed.stderr.length > 0) {
          managed.stderr.push(line);
          if (managed.stderr.length > MAX_BUFFER_LINES) {
            managed.stderr.shift();
            if (managed.stderrCursor > 0) managed.stderrCursor--;
          }
        }
      }
    });

    // Wire exit
    child.on('exit', (code) => {
      managed.status = 'exited';
      managed.exitCode = code ?? 1;
      this.logger.log(`Process ${id} (pid=${managed.pid}) exited with code ${code}`);
    });

    child.on('error', (err) => {
      managed.status = 'exited';
      managed.exitCode = 1;
      managed.stderr.push(`Process error: ${err.message}`);
      this.logger.error(`Process ${id} error: ${err.message}`);
    });

    this.processes.set(id, managed);
    this.logger.log(`Started process ${id}: "${command}" (pid=${child.pid}) in ${resolvedCwd}`);

    return this.toInfo(managed);
  }

  /**
   * Poll new output since last poll.
   */
  poll(id: string): { info: ProcessInfo; stdout: string; stderr: string } {
    const proc = this.getOrThrow(id);

    const newStdout = proc.stdout.slice(proc.stdoutCursor);
    const newStderr = proc.stderr.slice(proc.stderrCursor);

    proc.stdoutCursor = proc.stdout.length;
    proc.stderrCursor = proc.stderr.length;

    return {
      info: this.toInfo(proc),
      stdout: truncate(newStdout.join('\n'), MAX_POLL_OUTPUT),
      stderr: truncate(newStderr.join('\n'), MAX_POLL_OUTPUT / 2),
    };
  }

  /**
   * Send input to stdin of a running process.
   */
  send(id: string, input: string): void {
    const proc = this.getOrThrow(id);
    if (proc.status !== 'running') {
      throw new Error(`Process ${id} is not running (status=${proc.status})`);
    }
    if (!proc.child.stdin?.writable) {
      throw new Error(`Process ${id} stdin is not writable`);
    }
    proc.child.stdin.write(input + '\n');
  }

  /**
   * Kill a process by ID.
   */
  kill(id: string, signal: 'SIGTERM' | 'SIGKILL' = 'SIGTERM'): ProcessInfo {
    const proc = this.getOrThrow(id);
    if (proc.status === 'running') {
      proc.child.kill(signal);
      this.logger.log(`Sent ${signal} to process ${id} (pid=${proc.pid})`);
    }
    return this.toInfo(proc);
  }

  /**
   * List all managed processes.
   */
  list(): ProcessInfo[] {
    return [...this.processes.values()].map((p) => this.toInfo(p));
  }

  /**
   * Remove exited process from tracking (cleanup).
   */
  remove(id: string): void {
    const proc = this.processes.get(id);
    if (!proc) return;
    if (proc.status === 'running') {
      proc.child.kill('SIGTERM');
    }
    this.processes.delete(id);
  }

  // ─── Private ────────────────────────────────────────────────────────────────

  private getOrThrow(id: string): ManagedProcess {
    const proc = this.processes.get(id);
    if (!proc) {
      throw new Error(`Process "${id}" not found. Use action=list to see active processes.`);
    }
    return proc;
  }

  private runningCount(): number {
    let count = 0;
    for (const p of this.processes.values()) {
      if (p.status === 'running') count++;
    }
    return count;
  }

  private resolveCwd(requestedCwd?: string): string {
    if (!requestedCwd) return this.workingDirectory;

    const target = path.isAbsolute(requestedCwd)
      ? path.normalize(requestedCwd)
      : path.resolve(this.workingDirectory, requestedCwd);

    const relative = path.relative(this.workingDirectory, target);
    if (relative.startsWith('..') || path.isAbsolute(relative)) {
      throw new Error(`working_directory must stay within ${this.workingDirectory}`);
    }

    return target;
  }

  private toInfo(proc: ManagedProcess): ProcessInfo {
    return {
      id: proc.id,
      command: proc.command,
      cwd: proc.cwd,
      pid: proc.pid,
      startedAt: proc.startedAt,
      status: proc.status,
      exitCode: proc.exitCode,
    };
  }
}

function truncate(text: string, max: number): string {
  if (text.length <= max) return text;
  return text.slice(0, max - 50) + `\n\n... (truncated, ${text.length} total chars)`;
}
