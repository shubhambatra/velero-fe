import { Global, Module } from '@nestjs/common';

import { CryptoService } from './crypto.service';

/**
 * Global: encrypted columns appear in several feature modules (MFA secrets in
 * M1, OIDC client secrets in day 7, notification channel config in M6), and
 * PLAN.md §9 wants one place that holds key material.
 */
@Global()
@Module({
  providers: [CryptoService],
  exports: [CryptoService],
})
export class CryptoModule {}
