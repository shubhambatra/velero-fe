import { beforeAll, describe, expect, it } from 'vitest';

import { BreachedPasswordsService } from './breached-passwords';
import { PasswordService } from './password.service';

describe('PasswordService', () => {
  let service: PasswordService;
  let breached: BreachedPasswordsService;

  beforeAll(async () => {
    breached = new BreachedPasswordsService();
    await breached.onModuleInit();
    service = new PasswordService(breached);
  });

  describe('the bundled breached list', () => {
    it('loads the whole list', () => {
      // PLAN.md §8.3 asks for a top-100k list; after lower-casing and
      // deduplicating the NCSC list, 97 747 entries remain.
      expect(breached.size).toBeGreaterThan(90_000);
    });

    it('matches the passwords everyone actually tries', () => {
      for (const password of ['password', '123456', 'qwerty', 'letmein', 'password123']) {
        expect(breached.isBreached(password), password).toBe(true);
      }
    });

    it('matches regardless of capitalisation', () => {
      // Capitalising is the first thing a user does to satisfy a complexity
      // rule and buys nothing against a dictionary attack.
      expect(breached.isBreached('Password123')).toBe(true);
      expect(breached.isBreached('PASSWORD123')).toBe(true);
    });

    it('does not match a strong passphrase', () => {
      expect(breached.isBreached('canopy-vellum-ratchet-82')).toBe(false);
    });
  });

  describe('validate', () => {
    it('accepts a long, unbreached password', () => {
      expect(service.validate('canopy-vellum-ratchet-82')).toStrictEqual([]);
    });

    it('rejects anything under 12 characters (PLAN.md §8.3)', () => {
      expect(service.validate('short-11chr')).toContain('must be at least 12 characters');
      expect(service.validate('canopy-vellum')).toStrictEqual([]);
    });

    it('rejects a breached password even when it is long enough', () => {
      // The whole point of the list: length alone is not strength.
      expect(service.validate('iloveyou1234')).toContain(
        'appears in a list of commonly breached passwords',
      );
    });

    it('reports every problem at once rather than one at a time', () => {
      const problems = service.validate('password');
      expect(problems).toHaveLength(2);
      expect(problems).toContain('must be at least 12 characters');
      expect(problems).toContain('appears in a list of commonly breached passwords');
    });

    it('rejects whitespace padded to length', () => {
      expect(service.validate('              ')).toContain('must not be only whitespace');
    });

    it('caps the length, because argon2 reads the whole input', () => {
      expect(service.validate('a'.repeat(2_000))).toContain('must be at most 1024 characters');
    });

    it('rejects a password that is the account email or its local part', () => {
      expect(service.validate('alice@example.com', { email: 'alice@example.com' })).toContain(
        'must not be your email address',
      );
      expect(service.validate('ALICE@EXAMPLE.COM', { email: 'alice@example.com' })).toContain(
        'must not be your email address',
      );
      expect(service.validate('alice.mcbridge', { email: 'alice.mcbridge@example.com' })).toContain(
        'must not be your email address',
      );
    });

    it('does not reject a password that merely contains the email local part', () => {
      // Substring matching here would reject reasonable passphrases for
      // anyone whose address is a common word.
      expect(
        service.validate('alice-vellum-ratchet', { email: 'alice@example.com' }),
      ).toStrictEqual([]);
    });
  });

  describe('hash and verify', () => {
    it('produces an argon2id hash with the OWASP-recommended parameters', async () => {
      const hash = await service.hash('canopy-vellum-ratchet-82');

      // The library emits the parameters in m,p,t order.
      expect(hash).toMatch(/^\$argon2id\$v=19\$m=19456,p=1,t=2\$/);
    });

    it('verifies the correct password and rejects a wrong one', async () => {
      const hash = await service.hash('canopy-vellum-ratchet-82');

      await expect(service.verify(hash, 'canopy-vellum-ratchet-82')).resolves.toBe(true);
      await expect(service.verify(hash, 'canopy-vellum-ratchet-83')).resolves.toBe(false);
      await expect(service.verify(hash, '')).resolves.toBe(false);
    });

    it('salts every hash, so identical passwords do not collide', async () => {
      const a = await service.hash('canopy-vellum-ratchet-82');
      const b = await service.hash('canopy-vellum-ratchet-82');

      expect(a).not.toBe(b);
      await expect(service.verify(a, 'canopy-vellum-ratchet-82')).resolves.toBe(true);
      await expect(service.verify(b, 'canopy-vellum-ratchet-82')).resolves.toBe(true);
    });

    it('treats a malformed stored hash as a wrong password, not an error', async () => {
      // A truncated password_hash column must read as "no", never as a 500
      // that tells an attacker the account is unusual.
      for (const corrupt of ['', 'not-a-hash', '$argon2id$truncated']) {
        await expect(service.verify(corrupt, 'anything'), corrupt).resolves.toBe(false);
      }
    });

    it('reports that a weaker hash needs replacing, and a current one does not', async () => {
      const current = await service.hash('canopy-vellum-ratchet-82');
      expect(service.needsRehash(current)).toBe(false);

      // An older, cheaper hash of the same password.
      const weak =
        '$argon2id$v=19$m=4096,t=3,p=1$c29tZXNhbHRzb21lc2FsdA$iWh06vD8Fy27wf9npn6FXWiCX4K6pW6Ue1Bnzz07Z8A';
      expect(service.needsRehash(weak)).toBe(true);
    });
  });
});
