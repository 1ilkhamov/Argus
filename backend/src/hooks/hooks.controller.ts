import {
  Controller,
  Post,
  Put,
  Get,
  Param,
  Req,
  Res,
  HttpStatus,
  Logger,
  RawBodyRequest,
} from '@nestjs/common';
import type { Request, Response } from 'express';

import { HooksService, HookNotFoundError, HookPausedError, HookMethodNotAllowedError, HookAuthError, HookPayloadTooLargeError } from './hooks.service';
import { ConfigService } from '@nestjs/config';

/**
 * External-facing webhook controller.
 *
 * Receives HTTP requests from external services (GitHub, Stripe, etc.)
 * and routes them to the appropriate hook for processing.
 *
 * Auth: Each hook has its own secret token. External callers must send it via:
 * - Authorization: Bearer <token>
 * - x-hook-token: <token>
 *
 * This controller is NOT protected by the main API auth guard —
 * it uses per-hook token verification instead.
 */
@Controller('hooks')
export class HooksController {
  private readonly logger = new Logger(HooksController.name);
  private readonly hooksEnabled: boolean;

  constructor(
    private readonly hooksService: HooksService,
    private readonly configService: ConfigService,
  ) {
    this.hooksEnabled = this.configService.get<boolean>('hooks.enabled', true);
  }

  @Post(':name')
  async handlePost(
    @Param('name') name: string,
    @Req() req: RawBodyRequest<Request>,
    @Res() res: Response,
  ): Promise<void> {
    await this.handleHook(name, 'POST', req, res);
  }

  @Put(':name')
  async handlePut(
    @Param('name') name: string,
    @Req() req: RawBodyRequest<Request>,
    @Res() res: Response,
  ): Promise<void> {
    await this.handleHook(name, 'PUT', req, res);
  }

  @Get(':name')
  async handleGet(
    @Param('name') name: string,
    @Req() req: RawBodyRequest<Request>,
    @Res() res: Response,
  ): Promise<void> {
    await this.handleHook(name, 'GET', req, res);
  }

  private async handleHook(
    name: string,
    method: string,
    req: RawBodyRequest<Request>,
    res: Response,
  ): Promise<void> {
    if (!this.hooksEnabled) {
      res.status(HttpStatus.SERVICE_UNAVAILABLE).json({
        error: 'Webhooks are disabled.',
      });
      return;
    }

    // Extract auth token
    const authToken = this.extractToken(req);
    if (!authToken) {
      res.status(HttpStatus.UNAUTHORIZED).json({
        error: 'Missing authentication. Send token via Authorization: Bearer <token> or x-hook-token header.',
      });
      return;
    }

    // Extract payload
    let payload = '';
    if (method !== 'GET') {
      // Use raw body if available, otherwise stringified body
      if (req.rawBody) {
        payload = req.rawBody.toString('utf8');
      } else if (req.body) {
        payload = typeof req.body === 'string' ? req.body : JSON.stringify(req.body);
      }
    }

    // Extract headers (lowercase)
    const headers: Record<string, string> = {};
    for (const [key, value] of Object.entries(req.headers)) {
      if (typeof value === 'string') {
        headers[key.toLowerCase()] = value;
      } else if (Array.isArray(value)) {
        headers[key.toLowerCase()] = value.join(', ');
      }
    }

    // Extract query params
    const query: Record<string, string> = {};
    for (const [key, value] of Object.entries(req.query)) {
      if (typeof value === 'string') {
        query[key] = value;
      }
    }

    // Source IP
    const sourceIp = (req.ip || req.socket.remoteAddress || 'unknown');

    try {
      const result = await this.hooksService.fireHook(
        name,
        method,
        payload,
        headers,
        query,
        sourceIp,
        authToken,
      );

      res.status(HttpStatus.OK).json({
        status: result.success ? 'ok' : 'error',
        hookName: result.hookName,
        toolRoundsUsed: result.toolRoundsUsed,
        durationMs: result.durationMs,
        error: result.error,
      });
    } catch (error) {
      if (error instanceof HookNotFoundError) {
        res.status(HttpStatus.NOT_FOUND).json({ error: error.message });
      } else if (error instanceof HookPausedError) {
        res.status(HttpStatus.CONFLICT).json({ error: error.message });
      } else if (error instanceof HookMethodNotAllowedError) {
        res.status(HttpStatus.METHOD_NOT_ALLOWED).json({ error: error.message });
      } else if (error instanceof HookAuthError) {
        res.status(HttpStatus.FORBIDDEN).json({ error: error.message });
      } else if (error instanceof HookPayloadTooLargeError) {
        res.status(HttpStatus.PAYLOAD_TOO_LARGE).json({ error: error.message });
      } else {
        const msg = error instanceof Error ? error.message : String(error);
        this.logger.error(`Hook "${name}" execution failed: ${msg}`);
        res.status(HttpStatus.INTERNAL_SERVER_ERROR).json({ error: 'Internal hook execution error.' });
      }
    }
  }

  /**
   * Extract authentication token from request.
   * Supports:
   * - Authorization: Bearer <token>
   * - x-hook-token: <token>
   */
  private extractToken(req: Request): string | null {
    // Check Authorization header
    const authHeader = req.headers.authorization;
    if (authHeader) {
      const parts = authHeader.split(' ');
      if (parts.length === 2 && parts[0]!.toLowerCase() === 'bearer' && parts[1]) {
        return parts[1];
      }
    }

    // Check x-hook-token header
    const hookToken = req.headers['x-hook-token'];
    if (typeof hookToken === 'string' && hookToken) {
      return hookToken;
    }

    return null;
  }
}
