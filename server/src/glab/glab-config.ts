/**
 * GLab の在籍管理と GitHub 連携の設定 (spec/feature/glab-membership-github.md §5)。
 * 組織 ID が無ければ在籍の記録も無効。GitHub の値が欠けていれば記録だけ行い、反映は保留する。
 * @implements SPEC-GLAB-MEMBERSHIP-GITHUB
 */

export interface GlabGithubConfig {
  org: string;
  appId: string;
  installationId: string;
  privateKeyPem: string;
  webhookSecret: string;
  studentTeam: string;
  alumniTeam: string;
}

export interface GlabConfig {
  organizationId: string;
  github: GlabGithubConfig | null;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SLUG = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/;

export function readGlabConfig(env: NodeJS.ProcessEnv = process.env): GlabConfig | null {
  const organizationId = (env.CERNERE_GLAB_ORGANIZATION_ID ?? "").trim();
  if (!UUID.test(organizationId)) return null;
  const org = (env.CERNERE_GLAB_GITHUB_ORG ?? "").trim();
  const appId = (env.CERNERE_GLAB_GITHUB_APP_ID ?? "").trim();
  const installationId = (env.CERNERE_GLAB_GITHUB_INSTALLATION_ID ?? "").trim();
  // Vault/env では改行を \n で渡すことがあるので戻す。
  const privateKeyPem = (env.CERNERE_GLAB_GITHUB_APP_PRIVATE_KEY ?? "").replace(/\\n/g, "\n").trim();
  const webhookSecret = (env.CERNERE_GLAB_GITHUB_WEBHOOK_SECRET ?? "").trim();
  const studentTeam = (env.CERNERE_GLAB_GITHUB_STUDENT_TEAM ?? "students").trim();
  const alumniTeam = (env.CERNERE_GLAB_GITHUB_ALUMNI_TEAM ?? "alumni").trim();
  const complete = SLUG.test(org) && /^\d+$/.test(appId) && /^\d+$/.test(installationId)
    && privateKeyPem.includes("PRIVATE KEY") && webhookSecret.length >= 16
    && SLUG.test(studentTeam) && SLUG.test(alumniTeam) && studentTeam !== alumniTeam;
  return {
    organizationId,
    github: complete ? { org, appId, installationId, privateKeyPem, webhookSecret, studentTeam, alumniTeam } : null,
  };
}
