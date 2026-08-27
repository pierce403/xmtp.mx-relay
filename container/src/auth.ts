import crypto from 'node:crypto';

export function isAuthorized(authorizationHeader: string | undefined, expectedSecret: string): boolean {
  if (!authorizationHeader?.startsWith('Bearer ')) return false;
  const supplied = authorizationHeader.slice('Bearer '.length);
  const suppliedDigest = crypto.createHash('sha256').update(supplied).digest();
  const expectedDigest = crypto.createHash('sha256').update(expectedSecret).digest();
  return crypto.timingSafeEqual(suppliedDigest, expectedDigest);
}
