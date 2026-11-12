/**
 * The only User fields that may leave the server when one user sees another
 * (workspace members, audit actors, admin console lists). Never include a whole
 * User row: it carries `passwordHash` and `totpSecret`.
 */
export const PUBLIC_USER_SELECT = {
  id: true,
  name: true,
  email: true,
  image: true,
} as const;
