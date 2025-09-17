import React from 'react';
import { Link } from 'react-router-dom';

export default function App() {
  return (
    <div className="shell">
      <header className="topbar">
        <div className="brand"><span className="dot" /> TroofAI Companion</div>
        <div className="actions">
          {/* Dev aid: local service healthcheck */}
          <a className="btn" href="http://127.0.0.1:8787/health" target="_blank" rel="noreferrer">Service Health</a>
          <Link className="btn" to="/admin">Open Admin</Link>
          <Link className="btn" to="/companion">Open Companion</Link>
        </div>
      </header>

      <main className="hero">
        <h1>Hardware-backed Presence for Video Calls</h1>
        <p>Verify that participants are physically present on their enrolled devices — in real time.</p>
        <div className="cta">
          <Link className="btn lg" to="/admin">Admin Dashboard</Link>
          <Link className="btn lg" to="/companion">Companion App</Link>
        </div>

        <div className="card mt" style={{ maxWidth: 900, margin: '24px auto 0' }}>
          <h3>How this MVP works</h3>
          <ol>
            <li>Companion fetches a <b>public key</b> from the local service (simulated TPM/HSM) and registers it with the Hub (enrollment-gated).</li>
            <li>Admin triggers <b>Verify Now</b> → a visual challenge is flashed; the device <b>signs</b> a canonical payload and returns a sidecar.</li>
            <li>Admin verifies <b>signature + timing + luma</b> with the enrolled public key → shows a <b>Trusted</b> badge.</li>
          </ol>
          <p className="small muted" style={{ marginTop: 8 }}>
            {/* TODO(security): In production, the private key is non-exportable in TPM/Secure Enclave or Passkey/WebAuthn.
               This MVP uses a local Node service with file-backed keys purely for demo. Lock CORS and add auth (SSO/JWT/RBAC) in prod. */}
            Note: Private key never leaves the device in the real design. This demo uses a local service to simulate hardware signing.
          </p>
        </div>
      </main>
    </div>
  );
}