import { Injectable } from '@nestjs/common';

import { resolveResponseDirectives } from './response-directives.detectors';
import type { ResponseDirectives } from './response-directives.types';

@Injectable()
export class ResponseDirectivesService {
  resolve(content: string): ResponseDirectives {
    return resolveResponseDirectives(content);
  }
}
