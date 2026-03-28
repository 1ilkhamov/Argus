import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { execFile } from 'node:child_process';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';

import { LlmService } from '../../../llm/llm.service';
import { ToolRegistryService } from '../../core/registry/tool-registry.service';
import type { Tool, ToolDefinition } from '../../core/tool.types';
import { analyzeImageWithVision } from '../../shared/vision-analyze';

/** Maximum image file size (10 MB) */
const MAX_IMAGE_SIZE = 10 * 1024 * 1024;
/** Screenshot timeout */
const SCREENSHOT_TIMEOUT_MS = 10_000;
/** Supported image extensions */
const IMAGE_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.gif', '.bmp', '.webp', '.tiff']);

/**
 * Vision tool — capture screenshots and analyze images via LLM vision API.
 *
 * Actions:
 * - screenshot: Capture the current screen and analyze it
 * - analyze: Analyze an image file from disk
 */
@Injectable()
export class VisionTool implements Tool, OnModuleInit {
  private readonly logger = new Logger(VisionTool.name);
  private readonly screenshotDir: string;

  readonly definition: ToolDefinition = {
    name: 'vision',
    description:
      'Capture screenshots or analyze images using AI vision.\n\n' +
      'Actions:\n' +
      '- screenshot: Take a screenshot of the current screen and describe/analyze what is shown\n' +
      '- analyze: Analyze an image file from disk (provide path)\n\n' +
      'Use when the user says "what\'s on my screen", "что на экране", "посмотри на экран", ' +
      '"analyze this image", "опиши картинку", or asks about visual content.',
    parameters: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ['screenshot', 'analyze'],
          description: 'screenshot = capture screen, analyze = analyze image file.',
        },
        path: {
          type: 'string',
          description: 'Path to image file (for analyze action).',
        },
        question: {
          type: 'string',
          description: 'Specific question about the image (optional). Default: general description.',
        },
      },
      required: ['action'],
    },
    safety: 'safe',
  };

  constructor(
    private readonly registry: ToolRegistryService,
    private readonly llmService: LlmService,
    private readonly configService: ConfigService,
  ) {
    this.screenshotDir = this.configService.get<string>(
      'tools.vision.screenshotDir',
      path.join(process.cwd(), 'data', 'screenshots'),
    );
  }

  onModuleInit(): void {
    this.registry.register(this);
    this.logger.log('vision tool registered');
  }

  async execute(args: Record<string, unknown>): Promise<string> {
    const action = String(args.action ?? '').trim();
    const question = String(args.question ?? 'Describe what you see in this image in detail.').trim();

    try {
      switch (action) {
        case 'screenshot':
          return await this.takeAndAnalyzeScreenshot(question);
        case 'analyze':
          return await this.analyzeImageFile(String(args.path ?? ''), question);
        default:
          return `Error: Unknown action "${action}". Valid actions: screenshot, analyze.`;
      }
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      this.logger.error(`vision ${action} failed: ${msg}`);
      return `Error: ${msg}`;
    }
  }

  // ─── Actions ──────────────────────────────────────────────────────────────────

  private async takeAndAnalyzeScreenshot(question: string): Promise<string> {
    // Ensure screenshot directory exists
    await fs.mkdir(this.screenshotDir, { recursive: true });

    const filename = `screenshot_${Date.now()}.png`;
    const filePath = path.join(this.screenshotDir, filename);

    // Capture screenshot using macOS screencapture
    await this.captureScreen(filePath);

    try {
      const base64 = await this.readImageAsBase64(filePath);
      const analysis = await this.analyzeWithVision(base64, 'image/png', question);
      return `Screenshot captured and analyzed:\n\n${analysis}`;
    } finally {
      // Clean up screenshot file
      await fs.unlink(filePath).catch(() => {});
    }
  }

  private async analyzeImageFile(imagePath: string, question: string): Promise<string> {
    if (!imagePath) return 'Error: No image path provided.';

    // Resolve path
    const resolved = path.isAbsolute(imagePath) ? imagePath : path.resolve(process.cwd(), imagePath);

    // Validate
    const stat = await fs.stat(resolved);
    if (stat.isDirectory()) return 'Error: Path is a directory, not an image file.';
    if (stat.size > MAX_IMAGE_SIZE) return `Error: Image too large (${(stat.size / 1024 / 1024).toFixed(1)}MB, max 10MB).`;

    const ext = path.extname(resolved).toLowerCase();
    if (!IMAGE_EXTENSIONS.has(ext)) {
      return `Error: Unsupported image format "${ext}". Supported: ${[...IMAGE_EXTENSIONS].join(', ')}`;
    }

    const mimeType = this.getMimeType(ext);
    const base64 = await this.readImageAsBase64(resolved);
    const analysis = await this.analyzeWithVision(base64, mimeType, question);

    return `Image analysis (${path.basename(resolved)}):\n\n${analysis}`;
  }

  // ─── Helpers ──────────────────────────────────────────────────────────────────

  private captureScreen(outputPath: string): Promise<void> {
    return new Promise((resolve, reject) => {
      const command = this.getScreenshotCommand(outputPath);
      if (!command) {
        reject(new Error(`Screenshot capture is supported only on macOS and Windows. Current platform: ${process.platform}`));
        return;
      }

      execFile(command.file, command.args, { timeout: SCREENSHOT_TIMEOUT_MS, windowsHide: true }, (error) => {
        if (error) {
          reject(new Error(`Screenshot failed: ${error.message}`));
          return;
        }
        this.logger.log(`Screenshot saved: ${outputPath}`);
        resolve();
      });
    });
  }

  private getScreenshotCommand(outputPath: string): { file: string; args: string[] } | null {
    if (process.platform === 'darwin') {
      return {
        file: 'screencapture',
        args: ['-x', '-C', '-t', 'png', outputPath],
      };
    }

    if (process.platform === 'win32') {
      return {
        file: 'powershell.exe',
        args: ['-NoProfile', '-NonInteractive', '-Command', this.buildWindowsScreenshotScript(outputPath)],
      };
    }

    return null;
  }

  private buildWindowsScreenshotScript(outputPath: string): string {
    const escapedOutputPath = outputPath.replace(/'/g, "''");

    return [
      'Add-Type -AssemblyName System.Windows.Forms;',
      'Add-Type -AssemblyName System.Drawing;',
      '$bounds = [System.Windows.Forms.SystemInformation]::VirtualScreen;',
      '$bitmap = New-Object System.Drawing.Bitmap $bounds.Width, $bounds.Height;',
      '$graphics = [System.Drawing.Graphics]::FromImage($bitmap);',
      '$graphics.CopyFromScreen($bounds.X, $bounds.Y, 0, 0, $bitmap.Size);',
      `$bitmap.Save('${escapedOutputPath}', [System.Drawing.Imaging.ImageFormat]::Png);`,
      '$graphics.Dispose();',
      '$bitmap.Dispose();',
    ].join(' ');
  }

  private async readImageAsBase64(filePath: string): Promise<string> {
    const buffer = await fs.readFile(filePath);
    return buffer.toString('base64');
  }

  private async analyzeWithVision(base64: string, mimeType: string, question: string): Promise<string> {
    return analyzeImageWithVision(this.llmService, base64, mimeType, question);
  }

  private getMimeType(ext: string): string {
    const map: Record<string, string> = {
      '.png': 'image/png',
      '.jpg': 'image/jpeg',
      '.jpeg': 'image/jpeg',
      '.gif': 'image/gif',
      '.bmp': 'image/bmp',
      '.webp': 'image/webp',
      '.tiff': 'image/tiff',
    };
    return map[ext] ?? 'image/png';
  }
}
