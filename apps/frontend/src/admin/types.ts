export type AdminRole = "viewer" | "admin";

export interface AdminUser {
  id: string;
  email: string;
  name: string | null;
  role: AdminRole;
}

export interface AdminSession {
  user: AdminUser;
}

export interface LoginStart {
  browser_url: string;
  expires_in_seconds: number;
}

export interface LoginPoll {
  status: "pending" | "authenticated";
  session?: AdminSession;
}

export interface AuditEvent {
  id: string;
  actor_user_id: string;
  actor_email: string;
  actor_role: AdminRole | null;
  action: string;
  target_type: string | null;
  target_id: string | null;
  details: Record<string, unknown>;
  created_at: string;
}

export interface AuditEventPage {
  events: AuditEvent[];
  next_before: string | null;
}

export interface AdminMember {
  email: string;
  role: AdminRole;
}

const ROLE_RANK: Record<AdminRole, number> = { viewer: 1, admin: 2 };

/** Mirrors the backend's ordered roles; the backend remains the enforcement point. */
export function roleIncludes(role: AdminRole, required: AdminRole): boolean {
  return ROLE_RANK[role] >= ROLE_RANK[required];
}
