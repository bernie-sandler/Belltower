import { describe, expect, it } from 'vitest';
import { releaseOf, shouldShowWhatsNew } from './whatsNew';

const base = { appVersion: '1.6.0', lastSeen: '1.5.1', upgradedFrom: '1.5.1', enabled: true, notesVersion: '1.6.0' };

describe('shouldShowWhatsNew', () => {
  it('shows after an update', () => {
    expect(shouldShowWhatsNew(base)).toBe(true);
  });

  it('on a device with no version of its own, shows only when the install was upgraded', () => {
    // 1.5.x → 1.6.0: the device never stored a version, but the server knows it was upgraded.
    expect(shouldShowWhatsNew({ ...base, lastSeen: null, upgradedFrom: 'before 1.6.0' })).toBe(true);
    expect(shouldShowWhatsNew({ ...base, lastSeen: null, upgradedFrom: null })).toBe(false);
  });

  it('does not show for a version already seen, or in dev', () => {
    expect(shouldShowWhatsNew({ ...base, lastSeen: '1.6.0' })).toBe(false);
    expect(shouldShowWhatsNew({ ...base, appVersion: 'dev' })).toBe(false);
  });

  it('does not show when turned off, without notes, or with notes for another version', () => {
    expect(shouldShowWhatsNew({ ...base, enabled: false })).toBe(false);
    expect(shouldShowWhatsNew({ ...base, notesVersion: null })).toBe(false);
    expect(shouldShowWhatsNew({ ...base, notesVersion: '1.5.1' })).toBe(false);
  });

  it('matches an rc or the demo to its release notes', () => {
    expect(shouldShowWhatsNew({ ...base, appVersion: '1.6.0-rc.2' })).toBe(true);
    expect(shouldShowWhatsNew({ ...base, appVersion: '1.6.0 (demo)' })).toBe(true);
    expect(releaseOf('1.6.0-rc.12')).toBe('1.6.0');
    expect(releaseOf('1.6.0')).toBe('1.6.0');
  });
});
