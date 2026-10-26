export function platformJwtSecret(): string {
  const secret = process.env.PLATFORM_JWT_SECRET;
  if (!secret || secret.length < 32) {
    throw new Error('PLATFORM_JWT_SECRET must contain at least 32 characters');
  }
  return secret;
}
