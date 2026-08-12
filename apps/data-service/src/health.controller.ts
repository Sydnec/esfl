import { Controller, Get } from '@nestjs/common';
import { identiteVersion } from '@esfl/contracts';

@Controller('health')
export class HealthController {
  @Get()
  health() {
    return { status: 'ok', service: 'data-service', ...identiteVersion(process.env) };
  }
}
