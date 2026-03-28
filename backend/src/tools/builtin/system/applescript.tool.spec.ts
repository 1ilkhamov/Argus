import { Test } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';

import { AppleScriptTool } from './applescript.tool';
import { ToolRegistryService } from '../../core/registry/tool-registry.service';

// ─── Mock child_process ───────────────────────────────────────────────────────

let mockExecFileCallback: (
  error: { message: string; code?: number; killed?: boolean } | null,
  stdout: string,
  stderr: string,
) => void;

const mockExecFileChild = {
  kill: jest.fn(),
};

jest.mock('node:child_process', () => ({
  execFile: jest.fn((_cmd: string, _args: string[], _opts: unknown, callback: typeof mockExecFileCallback) => {
    mockExecFileCallback = callback;
    return mockExecFileChild;
  }),
}));

// ─── Mock os ──────────────────────────────────────────────────────────────────

let mockPlatform = 'darwin';

jest.mock('node:os', () => ({
  platform: () => mockPlatform,
}));

// ─── Helpers ──────────────────────────────────────────────────────────────────

const createTool = async (overrides?: {
  enabled?: boolean;
  timeoutMs?: number;
}): Promise<AppleScriptTool> => {
  const module = await Test.createTestingModule({
    providers: [
      AppleScriptTool,
      {
        provide: ToolRegistryService,
        useValue: { register: jest.fn() },
      },
      {
        provide: ConfigService,
        useValue: {
          get: jest.fn((key: string) => {
            if (key === 'tools.applescript.enabled') return overrides?.enabled ?? true;
            if (key === 'tools.applescript.timeoutMs') return overrides?.timeoutMs ?? 15000;
            return undefined;
          }),
        },
      },
    ],
  }).compile();

  return module.get(AppleScriptTool);
};

// Helper to simulate successful osascript execution
const resolveExec = (stdout = '', stderr = '') => {
  // Use queueMicrotask to ensure callback is called after execute starts waiting
  queueMicrotask(() => {
    mockExecFileCallback(null, stdout, stderr);
  });
};

const resolveExecError = (message: string, code = 1, killed = false) => {
  queueMicrotask(() => {
    mockExecFileCallback({ message, code, killed }, '', message);
  });
};

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('AppleScriptTool', () => {
  let tool: AppleScriptTool;

  beforeEach(async () => {
    jest.clearAllMocks();
    mockPlatform = 'darwin';
    tool = await createTool();
  });

  // ─── Registration ──────────────────────────────────────────────────────

  it('should have correct tool definition', () => {
    expect(tool.definition.name).toBe('applescript');
    expect(tool.definition.safety).toBe('moderate');
    expect(tool.definition.parameters.required).toEqual(['script']);
  });

  it('should not register on non-macOS platforms', async () => {
    mockPlatform = 'linux';
    const registry = { register: jest.fn() };
    const module = await Test.createTestingModule({
      providers: [
        AppleScriptTool,
        { provide: ToolRegistryService, useValue: registry },
        {
          provide: ConfigService,
          useValue: { get: jest.fn(() => true) },
        },
      ],
    }).compile();

    const linuxTool = module.get(AppleScriptTool);
    linuxTool.onModuleInit();
    expect(registry.register).not.toHaveBeenCalled();
  });

  // ─── Basic execution ───────────────────────────────────────────────────

  it('should execute AppleScript and return output', async () => {
    resolveExec('Hello from AppleScript');

    const result = await tool.execute({
      script: 'return "Hello from AppleScript"',
    });

    expect(result).toContain('Language: applescript');
    expect(result).toContain('Exit code: 0');
    expect(result).toContain('Hello from AppleScript');
  });

  it('should execute JXA scripts', async () => {
    resolveExec('42');

    const result = await tool.execute({
      script: '2 + 40',
      language: 'jxa',
    });

    expect(result).toContain('Language: jxa');
    expect(result).toContain('42');
  });

  it('should report script with no output', async () => {
    resolveExec('', '');

    const result = await tool.execute({
      script: 'tell application "Finder" to activate',
    });

    expect(result).toContain('no output');
  });

  it('should report stderr', async () => {
    resolveExec('', 'warning: deprecated');

    const result = await tool.execute({
      script: 'return 1',
    });

    expect(result).toContain('stderr');
    expect(result).toContain('deprecated');
  });

  // ─── Error handling ────────────────────────────────────────────────────

  it('should handle execution errors', async () => {
    resolveExecError('execution error: syntax error');

    const result = await tool.execute({
      script: 'invalid syntax here {{{{',
    });

    expect(result).toContain('Exit code: 1');
  });

  it('should report timeout', async () => {
    resolveExecError('killed', 1, true);

    const result = await tool.execute({
      script: 'delay 999',
    });

    expect(result).toContain('timed out');
  });

  it('should return error on non-macOS', async () => {
    mockPlatform = 'linux';

    const result = await tool.execute({
      script: 'return 1',
    });

    expect(result).toContain('only available on macOS');
  });

  // ─── Validation ────────────────────────────────────────────────────────

  it('should require script parameter', async () => {
    const result = await tool.execute({});
    expect(result).toContain('"script" is required');
  });

  it('should reject empty script', async () => {
    const result = await tool.execute({ script: '' });
    expect(result).toContain('"script" is required');
  });

  it('should reject overly long scripts', async () => {
    const result = await tool.execute({
      script: 'x'.repeat(10_001),
    });

    expect(result).toContain('too long');
  });

  it('should reject unknown language', async () => {
    const result = await tool.execute({
      script: 'return 1',
      language: 'python',
    });

    expect(result).toContain('Unsupported language');
  });

  // ─── Safety: blocked AppleScript patterns ──────────────────────────────

  it('should block file deletion commands', async () => {
    const result = await tool.execute({
      script: 'tell application "Finder" to delete every file of desktop',
    });

    expect(result).toContain('blocked pattern');
  });

  it('should block empty trash', async () => {
    const result = await tool.execute({
      script: 'tell application "Finder" to empty the trash',
    });

    expect(result).toContain('blocked pattern');
  });

  it('should block shell scripts with rm', async () => {
    const result = await tool.execute({
      script: 'do shell script "rm -rf /important"',
    });

    expect(result).toContain('blocked pattern');
  });

  it('should block shell scripts with sudo', async () => {
    const result = await tool.execute({
      script: 'do shell script "sudo reboot"',
    });

    expect(result).toContain('blocked pattern');
  });

  it('should block keystroke with password', async () => {
    const result = await tool.execute({
      script: 'keystroke "mypassword123"',
    });

    expect(result).toContain('blocked pattern');
  });

  it('should block shutdown commands', async () => {
    const result = await tool.execute({
      script: 'tell application "System Events" to shutdown',
    });

    expect(result).toContain('blocked pattern');
  });

  // ─── Safety: blocked JXA patterns ──────────────────────────────────────

  it('should block require(child_process) in JXA', async () => {
    const result = await tool.execute({
      script: 'const cp = require("child_process"); cp.execSync("rm -rf /")',
      language: 'jxa',
    });

    expect(result).toContain('blocked pattern');
  });

  it('should block eval() in JXA', async () => {
    const result = await tool.execute({
      script: 'eval("dangerous code")',
      language: 'jxa',
    });

    expect(result).toContain('blocked pattern');
  });

  it('should block Function() constructor in JXA', async () => {
    const result = await tool.execute({
      script: 'new Function("return process")()',
      language: 'jxa',
    });

    expect(result).toContain('blocked pattern');
  });

  // ─── Safe scripts should pass ──────────────────────────────────────────

  it('should allow getting frontmost app name', async () => {
    resolveExec('Safari');

    const result = await tool.execute({
      script: 'tell application "System Events" to get name of first process whose frontmost is true',
    });

    expect(result).toContain('Safari');
    expect(result).not.toContain('blocked');
  });

  it('should allow display dialog', async () => {
    resolveExec('button returned:OK');

    const result = await tool.execute({
      script: 'display dialog "Hello" buttons {"OK"}',
    });

    expect(result).toContain('OK');
    expect(result).not.toContain('blocked');
  });

  it('should allow getting system info in JXA', async () => {
    resolveExec('macOS 15.0');

    const result = await tool.execute({
      script: 'Application("System Events").systemInfo().systemVersion()',
      language: 'jxa',
    });

    expect(result).toContain('macOS');
    expect(result).not.toContain('blocked');
  });

  // ─── Timeout parameter ─────────────────────────────────────────────────

  it('should clamp timeout to minimum 1000ms', async () => {
    resolveExec('ok');

    const result = await tool.execute({
      script: 'return "ok"',
      timeout_ms: 100,
    });

    expect(result).toContain('ok');
  });

  it('should clamp timeout to maximum 60000ms', async () => {
    resolveExec('ok');

    const result = await tool.execute({
      script: 'return "ok"',
      timeout_ms: 999999,
    });

    expect(result).toContain('ok');
  });
});
