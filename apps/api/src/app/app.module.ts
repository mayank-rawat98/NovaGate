import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { TypeOrmModule } from '@nestjs/typeorm';
import configuration, { GatewayConfig } from '../config/configuration';
import { configSchema } from '../config/configuration.schema';
import { GatewayModule } from '../gateway/gateway.module';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      load: [configuration],
      validationSchema: configSchema,
    }),
    TypeOrmModule.forRootAsync({
      inject: [ConfigService],
      useFactory: (configService: ConfigService<GatewayConfig, true>) => ({
        type: 'postgres',
        url: configService.get('database', { infer: true }).url,
        autoLoadEntities: true,
        synchronize: true, // Only for development/demo
      }),
    }),
    GatewayModule,
  ],
})
export class AppModule {}
