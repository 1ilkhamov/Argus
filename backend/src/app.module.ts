import { Module } from '@nestjs/common';

import { AuthModule } from './common/auth/auth.module';
import { AppConfigModule } from './config/config.module';
import { LlmModule } from './llm/llm.module';
import { ChatModule } from './chat/chat.module';
import { HealthModule } from './health/health.module';
import { ToolsModule } from './tools/tools.module';
import { SettingsModule } from './settings/settings.module';
import { TranscriptionModule } from './transcription/transcription.module';
import { TelegramModule } from './telegram/telegram.module';
import { TelegramClientModule } from './telegram-client/telegram-client.module';

@Module({
  imports: [AppConfigModule, AuthModule, LlmModule, TranscriptionModule, ToolsModule, SettingsModule, ChatModule, HealthModule, TelegramModule, TelegramClientModule],
})
export class AppModule {}
