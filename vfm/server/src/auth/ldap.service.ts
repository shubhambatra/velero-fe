import { Inject, Injectable, Logger } from '@nestjs/common';
import { Client } from 'ldapts';

import { ENV } from '../config/config.module';
import type { Env } from '../config/env.schema';

/** Escapes a value for use inside an LDAP filter (RFC 4515). */
const escapeFilter = (value: string): string =>
  value.replace(/[\\*()\0]/g, (c) => `\\${c.charCodeAt(0).toString(16).padStart(2, '0')}`);

/**
 * Checks a password against a directory (SOW §5 "SSO/OIDC/LDAP"): find the entry by e-mail
 * with the service account, then bind as that entry. Never creates users; `login` decides
 * what a successful bind means.
 */
@Injectable()
export class LdapService {
  private readonly logger = new Logger(LdapService.name);

  constructor(@Inject(ENV) private readonly env: Env) {}

  get enabled(): boolean {
    return this.env.LDAP_URL !== undefined && this.env.LDAP_SEARCH_BASE !== undefined;
  }

  async verify(email: string, password: string): Promise<boolean> {
    const { LDAP_URL: url, LDAP_SEARCH_BASE: base } = this.env;
    // An empty password is an anonymous bind, which many servers accept.
    if (url === undefined || base === undefined || password === '') {
      return false;
    }
    const client = new Client({ url, timeout: 5_000, connectTimeout: 5_000 });
    try {
      if (url.startsWith('ldap://')) {
        if (!this.env.LDAP_START_TLS) {
          this.logger.error('LDAP_URL is ldap:// without LDAP_START_TLS; refusing to bind');
          return false;
        }
        await client.startTLS({});
      }
      if (this.env.LDAP_BIND_DN !== undefined && this.env.LDAP_BIND_PASSWORD !== undefined) {
        await client.bind(this.env.LDAP_BIND_DN, this.env.LDAP_BIND_PASSWORD);
      }
      const { searchEntries } = await client.search(base, {
        scope: 'sub',
        filter: this.env.LDAP_USER_FILTER.replace('{email}', escapeFilter(email)),
        attributes: ['dn'],
        sizeLimit: 2,
      });
      // Zero or several matches: no way to say which entry is meant.
      const [entry] = searchEntries;
      if (searchEntries.length !== 1 || entry === undefined) {
        return false;
      }
      await client.bind(entry.dn, password);
      return true;
    } catch (error: unknown) {
      this.logger.warn(`LDAP check failed: ${error instanceof Error ? error.name : 'unknown'}`);
      return false;
    } finally {
      await client.unbind().catch(() => undefined);
    }
  }
}
