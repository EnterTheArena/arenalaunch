// Browser test harness: a stand-in Phantom provider holding a THROWAWAY key derived from a name, so sign-in, lobbies and
// rehearsals can be clicked through without a real wallet. No libraries, no network (works under the site's CSP):
// Ed25519 comes from WebCrypto. Paste into the page (console or javascript_tool) after setting
//   window.__FAKE_NAME = 'arenalaunch-test-A';
// Never use it with a real key. It signs whatever the page asks — that is the point of a test double.
(async () => {
  const A = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
  const b58 = (u8) => { let n = 0n; for (const b of u8) n = n * 256n + BigInt(b); let s = ''; while (n > 0n) { s = A[Number(n % 58n)] + s; n /= 58n; } for (const b of u8) { if (b) break; s = '1' + s; } return s; };
  const seed = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(window.__FAKE_NAME || 'arenalaunch-test-A')));
  const pk8 = new Uint8Array([0x30, 0x2e, 0x02, 0x01, 0x00, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x70, 0x04, 0x22, 0x04, 0x20, ...seed]);
  const key = await crypto.subtle.importKey('pkcs8', pk8, { name: 'Ed25519' }, true, ['sign']);
  const jwk = await crypto.subtle.exportKey('jwk', key);
  const pub = Uint8Array.from(atob(jwk.x.replace(/-/g, '+').replace(/_/g, '/')), (c) => c.charCodeAt(0)); const addr = b58(pub);
  const sign = async (bytes) => new Uint8Array(await crypto.subtle.sign('Ed25519', key, bytes));
  const publicKey = { toBase58: () => addr, toString: () => addr, toBytes: () => pub };
  const p = {
    isPhantom: true, publicKey: null, fake: true,
    async connect() { p.publicKey = publicKey; return { publicKey }; },
    async disconnect() { p.publicKey = null; },
    async signMessage(bytes) { return { signature: await sign(bytes), publicKey }; },
    // Sign In With Solana (Phantom's signIn): builds the standard message from the input and signs it
    async signIn(input = {}) {
      p.publicKey = publicKey;
      const lines = [(input.domain || location.host) + ' wants you to sign in with your Solana account:', addr];
      if (input.statement) lines.push('', input.statement);
      const f = []; if (input.uri) f.push('URI: ' + input.uri); if (input.version) f.push('Version: ' + input.version); if (input.chainId) f.push('Chain ID: ' + input.chainId);
      if (input.nonce) f.push('Nonce: ' + input.nonce); if (input.issuedAt) f.push('Issued At: ' + input.issuedAt); if (input.expirationTime) f.push('Expiration Time: ' + input.expirationTime);
      if (f.length) lines.push('', ...f);
      const signedMessage = new TextEncoder().encode(lines.join('\n'));
      return { account: { address: addr, publicKey: pub }, signedMessage, signature: await sign(signedMessage) };
    },
  };
  window.phantom = { solana: p }; window.solana = p;
  window.alert = (m) => console.warn('ALERT', m); window.confirm = () => true; // dialogs would block the test driver
  return addr;
})();
