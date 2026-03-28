import { ConfigService } from '@nestjs/config';
import { Test } from '@nestjs/testing';

import { ProcessManagerService } from './process-manager.service';

// We test with real child processes (echo, sleep, cat) for integration-level confidence.
// Tests are kept short-lived to avoid CI flakiness.

describe('ProcessManagerService', () => {
  let service: ProcessManagerService;

  beforeEach(async () => {
    const module = await Test.createTestingModule({
      providers: [
        ProcessManagerService,
        {
          provide: ConfigService,
          useValue: {
            get: jest.fn((_key: string, fallback?: unknown) => fallback),
          },
        },
      ],
    }).compile();

    service = module.get(ProcessManagerService);
  });

  afterEach(() => {
    // Clean up all processes
    for (const p of service.list()) {
      service.remove(p.id);
    }
  });

  describe('start', () => {
    it('should start a process and return info', () => {
      const info = service.start('echo hello');
      expect(info.id).toHaveLength(8);
      expect(info.pid).toBeGreaterThan(0);
      expect(info.command).toBe('echo hello');
      expect(info.status).toBe('running');
      expect(info.exitCode).toBeNull();
    });

    it('should track the process in list', () => {
      service.start('echo test1');
      service.start('echo test2');
      expect(service.list()).toHaveLength(2);
    });
  });

  describe('poll', () => {
    it('should return stdout after process produces output', async () => {
      const info = service.start('echo "hello world"');

      // Wait for output
      await sleep(300);

      const { stdout } = service.poll(info.id);
      expect(stdout).toContain('hello world');
    });

    it('should return only new output on subsequent polls', async () => {
      const info = service.start('echo line1 && sleep 0.1 && echo line2');

      await sleep(100);
      const poll1 = service.poll(info.id);
      expect(poll1.stdout).toContain('line1');

      await sleep(200);
      const poll2 = service.poll(info.id);
      // line1 was already consumed — only line2 should appear
      expect(poll2.stdout).toContain('line2');
      expect(poll2.stdout).not.toContain('line1');
    });

    it('should show exit code after process finishes', async () => {
      const info = service.start('echo done');
      await sleep(300);

      const { info: updated } = service.poll(info.id);
      expect(updated.status).toBe('exited');
      expect(updated.exitCode).toBe(0);
    });

    it('should throw for unknown process ID', () => {
      expect(() => service.poll('nonexistent')).toThrow('not found');
    });
  });

  describe('send', () => {
    it('should write to stdin of running process', async () => {
      // cat echoes stdin to stdout
      const info = service.start('cat');
      await sleep(100);

      service.send(info.id, 'hello from stdin');
      await sleep(200);

      const { stdout } = service.poll(info.id);
      expect(stdout).toContain('hello from stdin');

      service.kill(info.id);
    });

    it('should throw for exited process', async () => {
      const info = service.start('echo fast');
      await sleep(300);

      expect(() => service.send(info.id, 'test')).toThrow('not running');
    });

    it('should throw for unknown process ID', () => {
      expect(() => service.send('nope', 'test')).toThrow('not found');
    });
  });

  describe('kill', () => {
    it('should terminate a running process', async () => {
      const info = service.start('sleep 60');
      expect(info.status).toBe('running');

      service.kill(info.id);
      await sleep(200);

      const list = service.list();
      const proc = list.find((p) => p.id === info.id);
      expect(proc?.status).toBe('exited');
    });

    it('should accept SIGKILL signal', async () => {
      const info = service.start('sleep 60');

      const result = service.kill(info.id, 'SIGKILL');
      expect(result.id).toBe(info.id);

      await sleep(200);
      const updated = service.list().find((p) => p.id === info.id);
      expect(updated?.status).toBe('exited');
    });

    it('should throw for unknown process ID', () => {
      expect(() => service.kill('nope')).toThrow('not found');
    });
  });

  describe('list', () => {
    it('should return empty array when no processes', () => {
      expect(service.list()).toEqual([]);
    });

    it('should return all processes with their status', async () => {
      service.start('echo quick');
      service.start('sleep 60');
      await sleep(300);

      const list = service.list();
      expect(list).toHaveLength(2);

      const statuses = list.map((p) => p.status);
      expect(statuses).toContain('exited');
      expect(statuses).toContain('running');
    });
  });

  describe('remove', () => {
    it('should remove a process from tracking', () => {
      const info = service.start('echo remove-me');
      expect(service.list()).toHaveLength(1);

      service.remove(info.id);
      expect(service.list()).toHaveLength(0);
    });

    it('should kill running process on remove', async () => {
      const info = service.start('sleep 60');
      service.remove(info.id);
      await sleep(100);
      expect(service.list()).toHaveLength(0);
    });
  });

  describe('onModuleDestroy', () => {
    it('should kill all running processes', async () => {
      service.start('sleep 60');
      service.start('sleep 60');
      expect(service.list()).toHaveLength(2);

      service.onModuleDestroy();
      // After destroy, internal map is cleared
      expect(service.list()).toHaveLength(0);
    });
  });
});

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
