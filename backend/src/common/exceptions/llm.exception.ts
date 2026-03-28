import { HttpException, HttpStatus } from '@nestjs/common';

export class LlmException extends HttpException {
  public readonly originalError?: Error;

  constructor(message: string, originalError?: Error) {
    super(
      {
        statusCode: HttpStatus.BAD_GATEWAY,
        error: 'LLM Service Error',
        message,
      },
      HttpStatus.BAD_GATEWAY,
    );
    this.originalError = originalError;
  }
}
