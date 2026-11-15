// Account → Notification sound: the bell's sound on this device (lib/sound.ts). Shown only where
// there's a bell: with Teams on, or to admins while the submit page is on.

import { Volume2 } from 'lucide-react';
import { useBellShown } from '../../api/config';
import { playSound, setSound, useSound, type SoundChoice } from '../../lib/sound';
import { Section } from '../settings/SettingsPage';

const SOUNDS: [SoundChoice, string][] = [
  ['off', 'Off'],
  ['chime', 'Chime'],
  ['ping', 'Ping'],
];

export function NotificationSoundSection() {
  const sound = useSound();
  const bell = useBellShown();
  if (!bell) return null;
  return (
    <Section icon={<Volume2 size={16} aria-hidden />} title="Notification sound">
      <div className="sound-row">
        <div className="segmented" role="radiogroup" aria-label="Sound for new notifications">
          {SOUNDS.map(([value, label]) => (
            <button
              key={value}
              type="button"
              role="radio"
              aria-checked={sound === value}
              className="segmented-item"
              onClick={() => {
                setSound(value);
                playSound(value, true);
              }}
            >
              {label}
            </button>
          ))}
        </div>
        <button type="button" className="btn btn-sm" disabled={sound === 'off'} onClick={() => playSound(sound, true)}>
          <Volume2 size={14} aria-hidden /> Test
        </button>
      </div>
      <p className="field-help">
        Saved on this device only. It plays when the bell gets something new, in one open tab, once you’ve clicked or typed on
        the page (browsers don’t allow sound before that).
      </p>
    </Section>
  );
}
