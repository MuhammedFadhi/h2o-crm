import { apiSuccess } from "@/lib/api-response";

// TEMPORARY diagnostic route — reports only presence/type of env vars, never
// their values. Delete once the Cloudflare Workers env wiring is confirmed.
export async function GET() {
  const keys = [
    "NEXT_PUBLIC_SUPABASE_URL",
    "NEXT_PUBLIC_SUPABASE_ANON_KEY",
    "SUPABASE_SERVICE_ROLE_KEY",
    "TENANT_ID",
    "CREDENTIAL_ENCRYPTION_KEY",
    "APP_BASE_URL",
    "NODE_ENV",
  ];

  const report: Record<string, string> = {};
  for (const key of keys) {
    const val = process.env[key];
    report[key] = val === undefined ? "MISSING" : `present (len ${val.length})`;
  }

  return apiSuccess(report);
}
