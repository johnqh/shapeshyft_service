/**
 * @fileoverview Firebase-backed AuthAdapter
 * @description Initializes `@sudobility/auth_service` and wraps its verifier in
 * a 5-minute cache. Disabled (for tests) it initializes nothing and rejects
 * every token, so a suite that forgets to mock auth fails loudly.
 */

import {
  createCachedVerifier,
  getUserInfo,
  initializeAuth,
  isAnonymousUser,
  isSiteAdmin,
} from "@sudobility/auth_service";
import type { AuthAdapter } from "../contracts.js";

export interface FirebaseAuthConfig {
  /** False under test: no Firebase initialization, and tokens are rejected. */
  enabled: boolean;
  projectId?: string;
  clientEmail?: string;
  privateKey?: string;
  /** Comma-separated site admin emails. */
  siteAdminEmails?: string;
  /** Verified-token cache lifetime. Default: 5 minutes. */
  cacheTtlMs?: number;
}

export function createFirebaseAuth(config: FirebaseAuthConfig): AuthAdapter {
  if (config.enabled) {
    if (!config.projectId || !config.clientEmail || !config.privateKey) {
      throw new Error(
        "Firebase auth needs projectId, clientEmail and privateKey"
      );
    }
    initializeAuth({
      firebase: {
        projectId: config.projectId,
        clientEmail: config.clientEmail,
        privateKey: config.privateKey,
      },
      siteAdminEmails: config.siteAdminEmails,
    });
  }

  const verifier = createCachedVerifier(config.cacheTtlMs ?? 300_000);

  return {
    async verifyIdToken(token) {
      if (!config.enabled) {
        throw new Error("Firebase verification not available in test mode");
      }
      return verifier.verify(token);
    },
    isSiteAdmin,
    isAnonymousUser,
    getUserInfo,
  };
}
