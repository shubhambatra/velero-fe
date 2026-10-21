import { describe, expect, it } from 'vitest';

import { mfaObligationFor, parseOrgSettings } from './org-mfa-policy';

describe('parseOrgSettings', () => {
  it('defaults mfaRequired to off, so adopting the product does not start with an enrolment drive', () => {
    expect(parseOrgSettings({})).toStrictEqual({
      mfaRequired: false,
      allowBackupContentDownload: false,
      requireRestoreApproval: false,
      auditRetentionDays: 400,
      auditExportBeforeDelete: false,
    });
    expect(parseOrgSettings(null)).toStrictEqual({
      mfaRequired: false,
      allowBackupContentDownload: false,
      requireRestoreApproval: false,
      auditRetentionDays: 400,
      auditExportBeforeDelete: false,
    });
    expect(parseOrgSettings(undefined)).toStrictEqual({
      mfaRequired: false,
      allowBackupContentDownload: false,
      requireRestoreApproval: false,
      auditRetentionDays: 400,
      auditExportBeforeDelete: false,
    });
  });

  it('reads an explicit setting', () => {
    expect(parseOrgSettings({ mfaRequired: true })).toStrictEqual({
      mfaRequired: true,
      allowBackupContentDownload: false,
      requireRestoreApproval: false,
      auditRetentionDays: 400,
      auditExportBeforeDelete: false,
    });
  });

  it('ignores unknown keys, so a row written by a newer version still parses', () => {
    expect(parseOrgSettings({ mfaRequired: true, somethingNewer: 42 })).toStrictEqual({
      mfaRequired: true,
      allowBackupContentDownload: false,
      requireRestoreApproval: false,
      auditRetentionDays: 400,
      auditExportBeforeDelete: false,
    });
  });

  it('falls back to the defaults for a malformed value rather than throwing', () => {
    // A hand-edited row must not be able to take the process down.
    expect(parseOrgSettings({ mfaRequired: 'yes' })).toStrictEqual({
      mfaRequired: false,
      allowBackupContentDownload: false,
      requireRestoreApproval: false,
      auditRetentionDays: 400,
      auditExportBeforeDelete: false,
    });
    expect(parseOrgSettings('not an object')).toStrictEqual({
      mfaRequired: false,
      allowBackupContentDownload: false,
      requireRestoreApproval: false,
      auditRetentionDays: 400,
      auditExportBeforeDelete: false,
    });
  });
});

describe('allowBackupContentDownload', () => {
  it('is off unless explicitly on, and a malformed value does not turn it on', () => {
    expect(parseOrgSettings({}).allowBackupContentDownload).toBe(false);
    expect(parseOrgSettings({ allowBackupContentDownload: true }).allowBackupContentDownload).toBe(
      true,
    );
    expect(
      parseOrgSettings({ allowBackupContentDownload: 'true' }).allowBackupContentDownload,
    ).toBe(false);
  });
});

describe('mfaObligationFor (PLAN.md §8.3)', () => {
  it('always requires MFA of a platform admin', () => {
    // The most privileged identity in the installation, and governed by no org.
    expect(mfaObligationFor({ isPlatformAdmin: true, memberships: [] })).toStrictEqual({
      required: true,
      reason: 'platform_admin',
    });
  });

  it('requires MFA of an org Owner and Admin by default', () => {
    for (const orgRole of ['OWNER', 'ADMIN'] as const) {
      expect(
        mfaObligationFor({
          isPlatformAdmin: false,
          memberships: [{ orgRole, settings: {} }],
        }),
        orgRole,
      ).toStrictEqual({ required: true, reason: 'org_role' });
    }
  });

  it('does not require it of a Member by default', () => {
    expect(
      mfaObligationFor({
        isPlatformAdmin: false,
        memberships: [{ orgRole: 'MEMBER', settings: {} }],
      }),
    ).toStrictEqual({ required: false, reason: null });
  });

  it('requires it of a Member when the org turns it on', () => {
    expect(
      mfaObligationFor({
        isPlatformAdmin: false,
        memberships: [{ orgRole: 'MEMBER', settings: { mfaRequired: true } }],
      }),
    ).toStrictEqual({ required: true, reason: 'org_policy' });
  });

  it('requires nothing of a user with no memberships', () => {
    expect(mfaObligationFor({ isPlatformAdmin: false, memberships: [] })).toStrictEqual({
      required: false,
      reason: null,
    });
  });

  describe('across several organizations', () => {
    it('applies the obligation if any org demands it', () => {
      // Taking the union, not the intersection: a Member in one org and an
      // Admin in another is an Admin somewhere.
      expect(
        mfaObligationFor({
          isPlatformAdmin: false,
          memberships: [
            { orgRole: 'MEMBER', settings: {} },
            { orgRole: 'ADMIN', settings: {} },
          ],
        }),
      ).toStrictEqual({ required: true, reason: 'org_role' });
    });

    it('applies it when only one org has the setting on', () => {
      expect(
        mfaObligationFor({
          isPlatformAdmin: false,
          memberships: [
            { orgRole: 'MEMBER', settings: { mfaRequired: false } },
            { orgRole: 'MEMBER', settings: { mfaRequired: true } },
          ],
        }),
      ).toStrictEqual({ required: true, reason: 'org_policy' });
    });

    it('reports the role as the reason when both a role and a policy apply', () => {
      // The role obligation cannot be turned off, so it is the more useful
      // explanation to show a user.
      expect(
        mfaObligationFor({
          isPlatformAdmin: false,
          memberships: [{ orgRole: 'OWNER', settings: { mfaRequired: true } }],
        }),
      ).toStrictEqual({ required: true, reason: 'org_role' });
    });
  });
});

describe('requireRestoreApproval', () => {
  it('is off unless the org turned it on, and survives garbage', () => {
    expect(parseOrgSettings({}).requireRestoreApproval).toBe(false);
    expect(parseOrgSettings({ requireRestoreApproval: true }).requireRestoreApproval).toBe(true);
    expect(parseOrgSettings({ requireRestoreApproval: 'yes' }).requireRestoreApproval).toBe(false);
  });
});

describe('audit retention settings', () => {
  it('default to 400 days with no export', () => {
    expect(parseOrgSettings({})).toMatchObject({
      auditRetentionDays: 400,
      auditExportBeforeDelete: false,
    });
  });
  it('accept a period from 30 to 3650 days and fall back to the default outside it', () => {
    expect(parseOrgSettings({ auditRetentionDays: 90 }).auditRetentionDays).toBe(90);
    expect(parseOrgSettings({ auditRetentionDays: 3650 }).auditRetentionDays).toBe(3650);
    // A hand-edited row must not be able to shorten the trail below a month: the whole row falls back.
    expect(parseOrgSettings({ auditRetentionDays: 1 }).auditRetentionDays).toBe(400);
    expect(parseOrgSettings({ auditRetentionDays: 99999 }).auditRetentionDays).toBe(400);
    expect(parseOrgSettings({ auditRetentionDays: 'soon' }).auditRetentionDays).toBe(400);
  });
});
