import { z } from "zod";

/** Minimum password length in characters. */
export const PASSWORD_MIN_LENGTH = 12;

/**
 * Hard cap on characters for any password-like input, to bound request cost before hashing.
 * Passwords are hashed with scrypt, which (unlike bcrypt's 72-byte limit) uses the whole input.
 */
export const PASSWORD_MAX_CHARS = 128;

export const emailSchema = z.string().trim().toLowerCase().max(254).email();

export const passwordSchema = z
  .string()
  .min(PASSWORD_MIN_LENGTH, `Password must be at least ${PASSWORD_MIN_LENGTH} characters`)
  .max(PASSWORD_MAX_CHARS, `Password must be at most ${PASSWORD_MAX_CHARS} characters`);

export const displayNameSchema = z.string().trim().min(1).max(80);

export const organizationNameSchema = z.string().trim().min(1).max(120);

export const registerSchema = z
  .object({
    email: emailSchema,
    password: passwordSchema,
    displayName: displayNameSchema,
    organizationName: organizationNameSchema,
  })
  .strict();

/** First-time invitees register directly into the invited organization, without creating a throwaway organization. */
export const registerWithInviteSchema = z
  .object({
    email: emailSchema,
    password: passwordSchema,
    displayName: displayNameSchema,
    inviteToken: z.string().trim().min(32).max(200),
  })
  .strict();

/**
 * Login deliberately does NOT apply the registration password policy: it must not reveal the
 * policy to attackers, and it must still bound input size so oversized bodies cannot be used to
 * make the server do expensive work.
 */
export const loginSchema = z
  .object({
    email: emailSchema,
    password: z.string().min(1).max(PASSWORD_MAX_CHARS),
  })
  .strict();

export type RegisterInput = z.infer<typeof registerSchema>;
export type RegisterWithInviteInput = z.infer<typeof registerWithInviteSchema>;
export type LoginInput = z.infer<typeof loginSchema>;

export const uuidSchema = z.string().uuid();
