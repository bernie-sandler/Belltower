// Test setup: unmount React trees between tests and pin the app time zone.
import { cleanup } from '@testing-library/react';
import { afterEach } from 'vitest';
import { setAppTimeZone } from '../lib/time';

setAppTimeZone('America/Chicago');
afterEach(() => cleanup());
