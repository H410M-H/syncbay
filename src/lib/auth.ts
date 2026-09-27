import NextAuth, { NextAuthOptions, getServerSession } from "next-auth";
import GitHubProvider from "next-auth/providers/github";
import CredentialsProvider from "next-auth/providers/credentials";
import { PrismaAdapter } from "@next-auth/prisma-adapter";
import { db } from "@/lib/db";
import { z } from "zod";
import bcrypt from "bcryptjs";

export const authOptions: NextAuthOptions = {
  adapter: PrismaAdapter(db),
  session: {
    strategy: "jwt",
  },
  providers: [
    GitHubProvider({
      clientId: process.env.GITHUB_CLIENT_ID ?? "",
      clientSecret: process.env.GITHUB_CLIENT_SECRET ?? "",
      issuer: "https://github.com/login/oauth",
      allowDangerousEmailAccountLinking: true,
      authorization: {
        params: {
          scope: "read:user user:email repo",
        },
      },
      token: {
        url: "https://github.com/login/oauth/access_token",
        async request({ params, provider }) {
          const res = await fetch("https://github.com/login/oauth/access_token", {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              Accept: "application/json",
            },
            body: JSON.stringify({
              client_id: provider.clientId,
              client_secret: provider.clientSecret,
              code: params.code,
              redirect_uri: provider.callbackUrl,
            }),
          });
          const tokens = await res.json();
          if (tokens.error) {
            console.error("[GitHub OAuth Token Exchange Error]", {
              error: tokens.error,
              description: tokens.error_description,
              callbackUrl: provider.callbackUrl,
            });
            throw new Error(`GitHub OAuth error: ${tokens.error_description || tokens.error}`);
          }
          return { tokens };
        },
      },
      profile(profile) {
        return {
          id: String(profile.id),
          name: profile.name ?? profile.login ?? null,
          email: profile.email ?? `${profile.id}+${profile.login}@users.noreply.github.com`,
          image: profile.avatar_url,
        };
      },
    }),
    CredentialsProvider({
      name: "Email & Password",
      credentials: {
        email: { label: "Email", type: "email" },
        password: { label: "Password", type: "password" },
      },
      async authorize(credentials) {
        const parsed = z
          .object({ email: z.string().email(), password: z.string().min(8) })
          .safeParse(credentials);

        if (!parsed.success) return null;

        const user = await db.user.findUnique({
          where: { email: parsed.data.email },
        });

        if (!user || !user.passwordHash) return null;

        const valid = await bcrypt.compare(
          parsed.data.password,
          user.passwordHash
        );

        if (!valid) return null;

        return { id: user.id, email: user.email, name: user.name };
      },
    }),
  ],
  callbacks: {
    async redirect({ url, baseUrl }) {
      // Allows relative callback URLs starting with "/" while preventing protocol-relative bypasses
      if (url.startsWith("/")) {
        if (!url.startsWith("//") && !url.startsWith("/\\")) {
          return `${baseUrl}${url}`;
        }
        return baseUrl;
      }
      // Allows callback URLs on the exact same origin
      try {
        const parsedUrl = new URL(url);
        if (parsedUrl.origin === baseUrl) {
          return url;
        }
      } catch {
        // Fallback on malformed URL
      }
      return baseUrl;
    },
    async jwt({ token, user, account }) {
      if (user) {
        token.id = user.id;
      }
      if (account?.provider === "github" && account.access_token) {
        token.accessToken = account.access_token;
        const targetUserId = user?.id || (token.id as string);
        if (targetUserId) {
          try {
            await db.account.upsert({
              where: {
                provider_providerAccountId: {
                  provider: account.provider,
                  providerAccountId: account.providerAccountId,
                },
              },
              update: {
                userId: targetUserId,
                access_token: account.access_token,
                token_type: account.token_type,
                scope: account.scope,
                refresh_token: account.refresh_token,
                expires_at: account.expires_at,
              },
              create: {
                userId: targetUserId,
                type: account.type,
                provider: account.provider,
                providerAccountId: account.providerAccountId,
                access_token: account.access_token,
                token_type: account.token_type,
                scope: account.scope,
                refresh_token: account.refresh_token,
                expires_at: account.expires_at,
              },
            });
          } catch (error) {
            console.error("[auth] Failed to persist GitHub account tokens:", error);
          }
        }
      }
      return token;
    },
    async session({ session, token }) {
      if (token.id) {
        session.user = { ...session.user, id: token.id as string };
      }
      return session;
    },
    async signIn({ user, account }) {
      // Auth.js may invoke this callback before the Prisma adapter has inserted the
      // OAuth user/account row. In that phase, a lookup by provider+account ID can
      // legitimately be empty, so we should allow the login to continue and let the
      // adapter complete the persistence flow.
      const persistedUser =
        (account?.provider && account.providerAccountId
          ? (
              await db.account.findUnique({
                where: {
                  provider_providerAccountId: {
                    provider: account.provider,
                    providerAccountId: account.providerAccountId,
                  },
                },
                include: { user: true },
              })
            )?.user ?? null
          : null) ??
        (user.id
          ? await db.user.findUnique({ where: { id: user.id } })
          : null) ??
        (user.email
          ? await db.user.findUnique({ where: { email: user.email } })
          : null);

      if (!persistedUser) {
        const hasOAuthIdentity = Boolean(
          account?.provider && account?.providerAccountId
        );

        if (hasOAuthIdentity) {
          console.warn("[v0] OAuth user not yet persisted; allowing sign-in to continue", {
            provider: account?.provider,
            providerAccountId: account?.providerAccountId,
            email: user.email,
          });
          return true;
        }

        console.error("[v0] OAuth user was not persisted before sign-in", {
          provider: account?.provider,
          providerAccountId: account?.providerAccountId,
        });
        return false;
      }
      user.id = persistedUser.id;

      // Auto-create personal workspace on first sign-in — FR-AUTH-04
      try {
        const existing = await db.workspace.findFirst({
          where: {
            members: { some: { userId: persistedUser.id } },
            isPersonal: true,
          },
        });
        if (!existing) {
          const baseName = persistedUser.name ?? "user";
          const slug = `${baseName
            .toLowerCase()
            .replace(/\s+/g, "-")
            .replace(/[^a-z0-9-]/g, "")
            .slice(0, 24)}-${persistedUser.id.slice(0, 6)}`;

          const workspace = await db.workspace.create({
            data: {
              name: persistedUser.name ?? "My Workspace",
              slug,
              isPersonal: true,
              members: {
                create: {
                  user: { connect: { id: persistedUser.id } },
                  role: "OWNER",
                },
              },
            },
          });

          // Append-only audit log — DR-04
          await db.auditLogEntry.create({
            data: {
              workspaceId: workspace.id,
              actorUserId: persistedUser.id,
              action: "workspace.created",
              metadata: { isPersonal: true },
            },
          });
        }
      } catch (error) {
        // Workspace provisioning must not reject an otherwise valid OAuth login.
        console.error("[v0] Personal workspace provisioning failed", error);
      }

      return true;
    },
  },
  pages: {
    signIn: "/auth/signin",
    error: "/auth/signin",
  },
  secret: process.env.NEXTAUTH_SECRET,
};

const handler = NextAuth(authOptions);
export { handler as GET, handler as POST };
export const auth = () => getServerSession(authOptions);

