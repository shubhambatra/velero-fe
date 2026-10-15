import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { TotpService } from './totp.service';

describe('TotpService', () => {
  const totp = new TotpService();

  describe('generateSecret', () => {
    it('produces a 160-bit base32 secret', () => {
      const secret = totp.generateSecret();

      // 20 bytes of base32 is 32 characters, the RFC 4226 recommendation.
      expect(secret).toMatch(/^[A-Z2-7]{32}$/);
    });

    it('produces a different secret each time', () => {
      const secrets = new Set(Array.from({ length: 20 }, () => totp.generateSecret()));

      expect(secrets.size).toBe(20);
    });
  });

  describe('provisioningUri', () => {
    it('carries the secret, the product as issuer and the email as label', () => {
      const uri = totp.provisioningUri('JBSWY3DPEHPK3PXP', 'alice@example.com');

      expect(uri.startsWith('otpauth://totp/')).toBe(true);
      expect(uri).toContain('secret=JBSWY3DPEHPK3PXP');
      expect(uri).toContain('issuer=Velero%20Fleet%20Manager');
      // The label disambiguates several accounts in one authenticator app.
      expect(decodeURIComponent(uri)).toContain('alice@example.com');
    });

    it('does not declare a period other than the 30 seconds apps default to', () => {
      // otplib omits the parameter when it matches the default, which is
      // correct: every authenticator assumes 30. What would break interop is
      // declaring a different one.
      const uri = totp.provisioningUri('JBSWY3DPEHPK3PXP', 'a@b.c');

      expect(uri).not.toMatch(/period=(?!30)\d+/);
    });
  });

  describe('verify', () => {
    it('accepts the current code', () => {
      const secret = totp.generateSecret();
      const token = totp.generateForTesting(secret);

      expect(totp.verify({ secret, token })).toMatchObject({ valid: true });
    });

    it('rejects a wrong code', () => {
      const secret = totp.generateSecret();

      expect(totp.verify({ secret, token: '000000' }).valid).toBe(false);
    });

    it('rejects a code for a different secret', () => {
      const token = totp.generateForTesting(totp.generateSecret());

      expect(totp.verify({ secret: totp.generateSecret(), token }).valid).toBe(false);
    });

    it('rejects anything that is not six digits', () => {
      const secret = totp.generateSecret();

      for (const token of ['', '1234', '1234567', 'abcdef', '12345a']) {
        expect(totp.verify({ secret, token }).valid, token).toBe(false);
      }
    });

    it('tolerates the spaces authenticator apps display', () => {
      const secret = totp.generateSecret();
      const token = totp.generateForTesting(secret);
      const grouped = `${token.slice(0, 3)} ${token.slice(3)}`;

      // People paste the code with the grouping space in; rejecting that would
      // be a formatting failure dressed up as a security control.
      expect(totp.verify({ secret, token: grouped }).valid).toBe(true);
    });

    it('reports the time step, which is what makes a code single-use', () => {
      const secret = totp.generateSecret();
      const result = totp.verify({ secret, token: totp.generateForTesting(secret) });

      expect(result.valid).toBe(true);
      if (result.valid) {
        // Unix time / 30, so it advances once per period.
        expect(result.timeStep).toBeGreaterThan(50_000_000);
      }
    });
  });

  describe('clock tolerance', () => {
    beforeEach(() => {
      vi.useFakeTimers();
    });

    afterEach(() => {
      vi.useRealTimers();
    });

    it('accepts a code from the previous step, because phone clocks drift', () => {
      vi.setSystemTime(new Date('2026-10-15T10:00:00.000Z'));
      const secret = totp.generateSecret();
      const token = totp.generateForTesting(secret);

      vi.setSystemTime(new Date('2026-10-15T10:00:35.000Z')); // one step later

      expect(totp.verify({ secret, token }).valid).toBe(true);
    });

    it('accepts a code from the next step, for a clock that runs fast', () => {
      vi.setSystemTime(new Date('2026-10-15T10:00:35.000Z'));
      const secret = totp.generateSecret();
      const token = totp.generateForTesting(secret);

      vi.setSystemTime(new Date('2026-10-15T10:00:00.000Z'));

      expect(totp.verify({ secret, token }).valid).toBe(true);
    });

    it('rejects a code two steps old, so a shoulder-surfed code expires quickly', () => {
      vi.setSystemTime(new Date('2026-10-15T10:00:00.000Z'));
      const secret = totp.generateSecret();
      const token = totp.generateForTesting(secret);

      vi.setSystemTime(new Date('2026-10-15T10:01:15.000Z')); // 2.5 steps later

      expect(totp.verify({ secret, token }).valid).toBe(false);
    });
  });

  describe('replay protection', () => {
    it('rejects a code whose step has already been spent', () => {
      const secret = totp.generateSecret();
      const token = totp.generateForTesting(secret);

      const first = totp.verify({ secret, token });
      expect(first.valid).toBe(true);
      if (!first.valid) {
        return;
      }

      // The same code, now that its step is recorded as used. Without this a
      // code observed over someone's shoulder stays usable for 30 seconds.
      expect(totp.verify({ secret, token, afterTimeStep: first.timeStep }).valid).toBe(false);
    });

    it('still accepts a code from a later step', () => {
      const secret = totp.generateSecret();
      const token = totp.generateForTesting(secret);
      const result = totp.verify({ secret, token });

      expect(result.valid).toBe(true);
      if (!result.valid) {
        return;
      }

      // A step before the recorded one: the next real code must still work.
      expect(totp.verify({ secret, token, afterTimeStep: result.timeStep - 1 }).valid).toBe(true);
    });
  });
});
