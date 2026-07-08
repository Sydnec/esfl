import { Module } from '@nestjs/common';
import { IngestionModule } from '../ingestion/ingestion.module';
import { PrismaService } from '../prisma.service';
import { CatalogController } from './catalog.controller';
import { CatalogService } from './catalog.service';

@Module({
  imports: [IngestionModule],
  controllers: [CatalogController],
  providers: [PrismaService, CatalogService],
})
export class CatalogModule {}
