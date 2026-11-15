import { describe, expect, it } from 'vitest';
import { shouldShowWhatsNew } from './whatsNew';

const base = { appVersion: '1.6.0', lastSeen: '1.5.1', enabled: true, hasNotes: true };

describe('shouldShowWhatsNew', () => {
  it('shows after an update', () => {
    expect(shouldShowWhatsNew(base)).toBe(true);
  });

  it('does not show on the first visit, for a version already seen, or in dev', () => {
    expect(shouldShowWhatsNew({ ...base, lastSeen: null })).toBe(false);
    expect(shouldShowWhatsNew({ ...base, lastSeen: '1.6.0' })).toBe(false);
    expect(shouldShowWhatsNew({ ...base, appVersion: 'dev' })).toBe(false);
  });

  it('does not show when turned off or with no notes', () => {
    expect(shouldShowWhatsNew({ ...base, enabled: false })).toBe(false);
    expect(shouldShowWhatsNew({ ...base, hasNotes: false })).toBe(false);
  });
});
