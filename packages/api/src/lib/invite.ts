import { randomInt } from "node:crypto";

/** Padding alphabet only: no I or O, which get read back as 1 and 0. */
const PAD_LETTERS = "ABCDEFGHJKLMNPQRSTUVWXYZ";

/**
 * Builds a code people can say out loud: four letters from the pot's name,
 * a dash, four digits. "Ikeja Early Birds" becomes something like IKEJ-2290.
 *
 * Deriving the letters from the name means the code is recognisable in a
 * group chat with three pots in it. The digits carry the randomness.
 *
 * Collisions are possible, so this returns a candidate and the caller retries
 * against a unique index. It never claims uniqueness it cannot enforce.
 */
export function inviteCodeCandidate(name: string): string {
  // The name's own letters are kept as they are, I and O included: the prefix
  // only works as a mnemonic if "Ikeja Early Birds" actually starts IKEJ.
  const letters = name.toUpperCase().replace(/[^A-Z]/g, "").slice(0, 4);

  const padded = letters.padEnd(4, randomLetters(4 - letters.length));
  const digits = randomInt(0, 10000).toString().padStart(4, "0");

  return `${padded}-${digits}`;
}

function randomLetters(n: number): string {
  let out = "";
  for (let i = 0; i < n; i++) out += PAD_LETTERS[randomInt(0, PAD_LETTERS.length)];
  return out;
}

/** Accepts what a human types: lowercase, missing dash, stray spaces. */
export function normaliseInviteCode(input: string): string {
  const cleaned = input.toUpperCase().replace(/[^A-Z0-9]/g, "");
  if (cleaned.length !== 8) return cleaned;
  return `${cleaned.slice(0, 4)}-${cleaned.slice(4)}`;
}
