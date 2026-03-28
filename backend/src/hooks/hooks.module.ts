import { Module } from '@nestjs/common';

import { HookRepository } from './hook.repository';
import { HooksService } from './hooks.service';
import { HooksController } from './hooks.controller';

@Module({
  controllers: [HooksController],
  providers: [HookRepository, HooksService],
  exports: [HooksService],
})
export class HooksModule {}
