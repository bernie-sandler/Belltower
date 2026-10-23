import type { ReactNode } from 'react';
import { BrandMark } from '../common/BrandMark';

export function AuthLayout({ title, children }: { title: string; children: ReactNode }) {
  return (
    <main className="auth-page">
      <div className="auth-card">
        <div className="auth-brand">
          <BrandMark size={36} />
          <span>Tower Tracker</span>
        </div>
        <h1 className="auth-title">{title}</h1>
        {children}
      </div>
    </main>
  );
}
