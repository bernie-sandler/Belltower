import { afterEach, describe, expect, it } from 'vitest';
import { getSetting } from '../src/db/connection';
import { APP_VERSION_KEY, recordAppVersion, UPGRADED_FROM_KEY, UPGRADED_FROM_UNKNOWN, upgradedFrom } from '../src/services/appVersion';
import { exportData } from '../src/services/backup';
import { client, makeApp, makeCtx, setupAndLogin, type TestApp } from './helpers';

describe('recordAppVersion', () => {
  it('a fresh install records its version and has never been upgraded', () => {
    const { ctx } = makeCtx();
    recordAppVersion(ctx, '1.6.0', true);
    expect(getSetting(ctx.db, APP_VERSION_KEY)).toBe('1.6.0');
    expect(upgradedFrom(ctx)).toBeNull();
    // Restarting on the same version changes nothing.
    recordAppVersion(ctx, '1.6.0', false);
    expect(upgradedFrom(ctx)).toBeNull();
  });

  it('an install from before 1.6.0 counts as upgraded from an unknown version', () => {
    const { ctx } = makeCtx();
    recordAppVersion(ctx, '1.6.0', false);
    expect(upgradedFrom(ctx)).toBe(UPGRADED_FROM_UNKNOWN);
  });

  it('remembers the version before the last change', () => {
    const { ctx } = makeCtx();
    recordAppVersion(ctx, '1.6.0', true);
    recordAppVersion(ctx, '1.6.1', false);
    expect(upgradedFrom(ctx)).toBe('1.6.0');
    recordAppVersion(ctx, '1.6.1', false);
    expect(upgradedFrom(ctx)).toBe('1.6.0');
    expect(getSetting(ctx.db, APP_VERSION_KEY)).toBe('1.6.1');
  });

  it('a dev build records nothing', () => {
    const { ctx } = makeCtx();
    recordAppVersion(ctx, 'dev', false);
    expect(getSetting(ctx.db, APP_VERSION_KEY)).toBeNull();
    expect(upgradedFrom(ctx)).toBeNull();
  });

  it('is left out of backups', () => {
    const { ctx } = makeCtx();
    recordAppVersion(ctx, '1.6.0', false);
    const keys = (exportData(ctx, '1.6.0').tables.settings as { key: string }[]).map((r) => r.key);
    expect(keys).not.toContain(APP_VERSION_KEY);
    expect(keys).not.toContain(UPGRADED_FROM_KEY);
  });
});

describe('GET /api/config', () => {
  let t: TestApp;
  afterEach(() => t.shutdown());

  it('says which version the install was upgraded from', async () => {
    t = await makeApp();
    const api = client(t.app, await setupAndLogin(t));
    expect((await api('GET', '/api/config')).json()).toMatchObject({ upgradedFrom: null });
    recordAppVersion(t.ctx, '1.6.0', true);
    recordAppVersion(t.ctx, '1.6.1', false);
    expect((await api('GET', '/api/config')).json()).toMatchObject({ upgradedFrom: '1.6.0' });
  });
});
