// A Phantom account's vault key: SHA-256(signature over the fixed unlock message || the account's pepper).
// The relay hands the pepper out only with a fresh Sign In With Solana, so a phished unlock signature plus a stolen
// session cannot open the vault. Without a pepper: the key accounts were sealed with before it existed (migrated on sign-in).
export async function vaultKey(sig, pepper = null) {
  const all = new Uint8Array(sig.length + (pepper ? pepper.length : 0)); all.set(sig); if (pepper) all.set(pepper, sig.length);
  return new Uint8Array(await crypto.subtle.digest('SHA-256', all));
}
