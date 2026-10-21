import { Module } from '@nestjs/common';

import { CryptoModule } from '../crypto/crypto.module';
import { CaService } from './ca.service';

@Module({
  imports: [CryptoModule],
  providers: [CaService],
  exports: [CaService],
})
export class CaModule {}
